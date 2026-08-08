    fn runtime_tab_ids_for_sources(core: &AppCore, source_ids: &[&str]) -> Vec<String> {
        core.invoke(CoreCommand::BrowserRuntimeSnapshot)
            .unwrap()["tabs"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|tab| {
                tab["sourceId"]
                    .as_str()
                    .is_some_and(|source_id| source_ids.contains(&source_id))
            })
            .filter_map(|tab| tab["id"].as_str().map(str::to_owned))
            .collect()
    }

    #[test]
    fn window_scoped_stop_and_delete_finish_from_one_authoritative_snapshot() {
        for platform in ["darwin", "win32"] {
            let (_directory, core) = core_for_platform(platform);
            let game_id = first_game_id(&core);
            let role_id = create_role(&core, &game_id, 1);
            let workspace_role_id = create_role(&core, &game_id, 2);
            let other_role_id = create_role(&core, &game_id, 3);
            let deleted_role_id = create_role(&core, &game_id, 4);
            let failed_role_id = create_role(&core, &game_id, 5);
            let workspace_id = core
                .invoke(command(json!({
                    "type": "workspaceCreate",
                    "input": {
                        "name": "Stop together workspace",
                        "template": "single",
                        "slots": [{
                            "roleId": workspace_role_id,
                            "rect": workspace_rect(0, 1)
                        }]
                    }
                })))
                .unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned();
            let create_window = |name: &str| {
                core.invoke(command(json!({
                    "type": "gameWindowCreate",
                    "input": {
                        "name": name,
                        "targetDisplay": { "id": 1 },
                        "placement": {
                            "normalBounds": { "x": 0, "y": 0, "width": 960, "height": 640 },
                            "savedWorkArea": { "x": 0, "y": 0, "width": 1440, "height": 900 },
                            "presentation": "normal"
                        }
                    }
                })))
                .unwrap()["id"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            };
            let target = |window_id: &str| EmbeddedLaunchTargetRecord {
                window_id: window_id.to_owned(),
                display_id: 1,
                scale_factor: 1.0,
                work_area: StatePixelBoundsRecord {
                    x: 0,
                    y: 0,
                    width: 1440,
                    height: 900,
                },
                bounds: StatePixelBoundsRecord {
                    x: 0,
                    y: 0,
                    width: 960,
                    height: 640,
                },
                presentation: "normal".to_owned(),
            };
            let stopped_window_id = create_window("Stop together");
            let other_window_id = create_window("Keep running");
            drive_accepted_launch_to_completion(
                Arc::clone(&core),
                CoreCommand::BrowserRoleLaunch {
                    role_id: role_id.clone(),
                    target: target(&stopped_window_id),
                    launch_preview_id: None,
                    zoom_factor: None,
                    restore_role_slots: None,
                },
            );
            drive_accepted_launch_to_completion(
                Arc::clone(&core),
                browser_workspace_launch(workspace_id.clone(), target(&stopped_window_id)),
            );
            drive_accepted_launch_to_completion(
                Arc::clone(&core),
                CoreCommand::BrowserRoleLaunch {
                    role_id: other_role_id.clone(),
                    target: target(&other_window_id),
                    launch_preview_id: None,
                    zoom_factor: None,
                    restore_role_slots: None,
                },
            );
            let stop_request = test_window_stop_request(
                stopped_window_id.clone(),
                runtime_tab_ids_for_sources(&core, &[role_id.as_str(), workspace_id.as_str()]),
            );
            let parent_operation_id = stop_request.parent_operation_id.clone();
            drive_async_command_with(
                Arc::clone(&core),
                CoreCommand::BrowserWindowStop {
                    request: stop_request,
                },
                |effect| effect_result_with_parent(effect, &parent_operation_id, platform),
            )
            .0
            .unwrap();
            let runtime = core.invoke(CoreCommand::BrowserRuntimeSnapshot).unwrap();
            assert_eq!(runtime["tabs"].as_array().unwrap().len(), 1, "{platform}");
            assert_eq!(runtime["roles"].as_array().unwrap().len(), 1, "{platform}");
            assert_eq!(runtime["roles"][0]["roleId"], other_role_id, "{platform}");
            assert!(
                runtime["workspaces"].as_array().unwrap().is_empty(),
                "{platform}"
            );
            assert!(runtime["windows"].as_array().unwrap().is_empty(), "{platform}");
            let stopped_windows = core.invoke(CoreCommand::GameWindowsList).unwrap();
            let stopped_window = stopped_windows
                .as_array()
                .unwrap()
                .iter()
                .find(|window| window["id"] == stopped_window_id)
                .unwrap();
            let stopped_sources = stopped_window["tabs"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|tab| tab["sourceId"].as_str())
                .collect::<HashSet<_>>();
            assert!(stopped_sources.is_empty(), "{platform}");
            drive_accepted_launch_to_completion(
                Arc::clone(&core),
                CoreCommand::BrowserRoleLaunch {
                    role_id: role_id.clone(),
                    target: target(&stopped_window_id),
                    launch_preview_id: None,
                    zoom_factor: None,
                    restore_role_slots: None,
                },
            );
            drive_accepted_launch_to_completion(
                Arc::clone(&core),
                browser_workspace_launch(workspace_id.clone(), target(&stopped_window_id)),
            );
            let reopened = core.invoke(CoreCommand::BrowserRuntimeSnapshot).unwrap();
            let reopened_tabs = reopened["tabs"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|tab| {
                    matches!(
                        tab["sourceId"].as_str(),
                        Some(source_id)
                            if source_id == role_id || source_id == workspace_id
                    )
                })
                .count();
            assert_eq!(
                reopened_tabs,
                2,
                "{platform}"
            );
            drive_async_command(
                Arc::clone(&core),
                CoreCommand::BrowserWindowStop {
                    request: test_window_stop_request(
                        stopped_window_id.clone(),
                        runtime_tab_ids_for_sources(
                        &core,
                        &[role_id.as_str(), workspace_id.as_str()],
                    ),
                    ),
                },
                None,
            )
            .0
            .unwrap();
            let stopped_again = core.invoke(CoreCommand::GameWindowsList).unwrap();
            let stopped_again = stopped_again
                .as_array()
                .unwrap()
                .iter()
                .find(|window| window["id"] == stopped_window_id)
                .unwrap();
            assert_eq!(
                stopped_again["tabs"].as_array().unwrap().len(),
                0,
                "{platform}"
            );
            let deleted_window_id = create_window("Delete together");
            drive_accepted_launch_to_completion(
                Arc::clone(&core),
                CoreCommand::BrowserRoleLaunch {
                    role_id: deleted_role_id.clone(),
                    target: target(&deleted_window_id),
                    launch_preview_id: None,
                    zoom_factor: None,
                    restore_role_slots: None,
                },
            );
            drive_async_command(
                Arc::clone(&core),
                CoreCommand::BrowserWindowDelete {
                    request: test_window_stop_request(
                        deleted_window_id.clone(),
                        runtime_tab_ids_for_sources(&core, &[deleted_role_id.as_str()]),
                    ),
                },
                None,
            )
            .0
            .unwrap();
            let windows = core.invoke(CoreCommand::GameWindowsList).unwrap();
            assert!(
                windows
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|window| window["id"].as_str() != Some(deleted_window_id.as_str())),
                "{platform}"
            );
            let failed_window_id = create_window("Preserve after failure");
            drive_accepted_launch_to_completion(
                Arc::clone(&core),
                CoreCommand::BrowserRoleLaunch {
                    role_id: failed_role_id.clone(),
                    target: target(&failed_window_id),
                    launch_preview_id: None,
                    zoom_factor: None,
                    restore_role_slots: None,
                },
            );
            let failed = drive_async_command(
                Arc::clone(&core),
                CoreCommand::BrowserWindowStop {
                    request: test_window_stop_request(
                        failed_window_id.clone(),
                        runtime_tab_ids_for_sources(&core, &[failed_role_id.as_str()]),
                    ),
                },
                Some("embeddedDestroyTab"),
            )
            .0;
            assert!(failed.is_err(), "{platform}");
            let windows = core.invoke(CoreCommand::GameWindowsList).unwrap();
            let failed_window = windows
                .as_array()
                .unwrap()
                .iter()
                .find(|window| window["id"] == failed_window_id)
                .unwrap();
            assert_eq!(
                failed_window["tabs"].as_array().unwrap().len(),
                0,
                "{platform}"
            );
            core.shutdown();
        }
    }

    #[test]
    fn live_tab_scope_prevents_a_stale_core_window_from_stopping_a_detached_tab() {
        for platform in ["darwin", "win32"] {
            let (_directory, core) = core_for_platform(platform);
            let game_id = first_game_id(&core);
            let source_role_id = create_role(&core, &game_id, 1);
            let detached_role_id = create_role(&core, &game_id, 2);
            let window_id = "source-window".to_owned();
            let target = EmbeddedLaunchTargetRecord {
                window_id: window_id.clone(),
                display_id: 1,
                scale_factor: 1.0,
                work_area: StatePixelBoundsRecord {
                    x: 0,
                    y: 0,
                    width: 1440,
                    height: 900,
                },
                bounds: StatePixelBoundsRecord {
                    x: 0,
                    y: 0,
                    width: 960,
                    height: 640,
                },
                presentation: "normal".to_owned(),
            };
            for role_id in [&source_role_id, &detached_role_id] {
                drive_accepted_launch_to_completion(
                    Arc::clone(&core),
                    CoreCommand::BrowserRoleLaunch {
                        role_id: role_id.clone(),
                        target: target.clone(),
                        launch_preview_id: None,
                        zoom_factor: None,
                        restore_role_slots: None,
                    },
                );
            }
            let before = core.invoke(CoreCommand::BrowserRuntimeSnapshot).unwrap();
            let source_tab_id = before["tabs"]
                .as_array()
                .unwrap()
                .iter()
                .find(|tab| tab["sourceId"] == source_role_id)
                .unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned();

            drive_async_command(
                Arc::clone(&core),
                CoreCommand::BrowserWindowStop {
                    request: test_window_stop_request(window_id, vec![source_tab_id]),
                },
                None,
            )
            .0
            .unwrap();

            let after = core.invoke(CoreCommand::BrowserRuntimeSnapshot).unwrap();
            assert_eq!(after["tabs"].as_array().unwrap().len(), 1, "{platform}");
            assert_eq!(
                after["tabs"][0]["sourceId"], detached_role_id,
                "{platform}"
            );
            assert_eq!(after["roles"].as_array().unwrap().len(), 1, "{platform}");
            assert_eq!(
                after["roles"][0]["roleId"], detached_role_id,
                "{platform}"
            );
            core.shutdown();
        }
    }

    #[test]
    fn log_level_persists_across_core_restarts_on_supported_platforms() {
        for platform in ["darwin", "win32"] {
            let directory = tempfile::tempdir().unwrap();
            let options = || AppCoreOptions {
                app_version: "2.1.0-test".to_owned(),
                platform: platform.to_owned(),
                user_data_dir: directory.path().to_string_lossy().into_owned(),
                performance_telemetry_path: None,
            };

            let first = AppCore::create(options()).unwrap();
            assert_eq!(
                first.invoke(CoreCommand::LogsStatus).unwrap()["currentLevel"],
                "debug"
            );
            first
                .invoke(CoreCommand::LogsSetLevel {
                    level: LogLevel::Debug,
                })
                .unwrap();
            first.shutdown();
            drop(first);

            let restored = AppCore::create(options()).unwrap();
            assert_eq!(
                restored.invoke(CoreCommand::LogsStatus).unwrap()["currentLevel"],
                "debug"
            );
            restored
                .invoke(command(json!({
                    "type": "logsCapture",
                    "entries": [{
                        "level": "debug",
                        "source": "main",
                        "event": "restored_debug_capture",
                        "message": "Persisted debug logging is active."
                    }]
                })))
                .unwrap();
            let debug_page = restored
                .invoke(command(json!({
                    "type": "logsQuery",
                    "query": {"levels": ["debug"], "limit": 10}
                })))
                .unwrap();
            assert!(
                debug_page["entries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|entry| entry["event"] == "restored_debug_capture")
            );
            restored
                .invoke(CoreCommand::LogsSetLevel {
                    level: LogLevel::Info,
                })
                .unwrap();
            restored.shutdown();
            drop(restored);

            let reset = AppCore::create(options()).unwrap();
            assert_eq!(
                reset.invoke(CoreCommand::LogsStatus).unwrap()["currentLevel"],
                "info"
            );
            reset.shutdown();
        }
    }

    #[test]
    fn invalid_persisted_log_level_falls_back_to_debug() {
        let (directory, core) = core();
        core.shutdown();
        drop(core);
        let connection =
            rusqlite::Connection::open(directory.path().join("rion-studio.sqlite3")).unwrap();
        connection
            .execute(
                "INSERT INTO settings(key, payload_json) VALUES ('logLevel', 'not-json')
                 ON CONFLICT(key) DO UPDATE SET payload_json=excluded.payload_json",
                [],
            )
            .unwrap();
        drop(connection);

        let restored = AppCore::create(AppCoreOptions {
            app_version: "2.1.0-test".to_owned(),
            platform: "darwin".to_owned(),
            user_data_dir: directory.path().to_string_lossy().into_owned(),
            performance_telemetry_path: None,
        })
        .unwrap();
        assert_eq!(
            restored.invoke(CoreCommand::LogsStatus).unwrap()["currentLevel"],
            "debug"
        );
        restored.shutdown();
    }

    #[test]
    fn failed_log_level_persistence_does_not_change_the_runtime_level() {
        let (_directory, core) = core();
        let connection = rusqlite::Connection::open(&core.database_paths.state).unwrap();
        connection
            .execute_batch(
                "CREATE TRIGGER reject_log_level_insert
                 BEFORE INSERT ON settings
                 WHEN NEW.key='logLevel'
                 BEGIN
                   SELECT RAISE(ABORT, 'fixture rejects log level persistence');
                 END;",
            )
            .unwrap();

        assert!(
            core.invoke(CoreCommand::LogsSetLevel {
                level: LogLevel::Debug,
            })
            .is_err()
        );
        assert_eq!(
            core.invoke(CoreCommand::LogsStatus).unwrap()["currentLevel"],
            "debug"
        );
        assert!(
            core.with_runtime(|runtime| runtime.state.read_scalar("logLevel".to_owned()))
                .unwrap()
                .is_none()
        );
        core.shutdown();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn runtime_aware_role_delete_removes_data_and_committed_quarantine() {
        let (directory, core) = core();
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let browser = directory
            .path()
            .join("roles")
            .join(&role_id)
            .join("browser");
        fs::write(browser.join("session"), b"signed-in").unwrap();

        core.clone()
            .invoke_async(CoreCommand::RoleDelete {
                id: role_id.clone(),
            })
            .await
            .unwrap();

        {
            assert!(!directory.path().join("roles").join(&role_id).exists());
            assert!(
                core.invoke(CoreCommand::RolesList)
                    .unwrap()
                    .as_array()
                    .unwrap()
                    .is_empty()
            );
            assert!(
                core.with_runtime(|runtime| runtime.state.operation_journals())
                    .unwrap()
                    .is_empty()
            );
        };
        core.shutdown();
    }
