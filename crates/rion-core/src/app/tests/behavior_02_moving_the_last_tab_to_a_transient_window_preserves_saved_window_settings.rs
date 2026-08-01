#[test]
    fn moving_the_last_tab_to_a_transient_window_preserves_saved_window_settings() {
        for platform in ["darwin", "win32"] {
            let (_directory, core) = core_for_platform(platform);
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
            let source_id = create_window("Source");
            let target_id = create_window("Target");
            let dormant_tab_ids = [
                uuid::Uuid::new_v4().to_string(),
                uuid::Uuid::new_v4().to_string(),
                uuid::Uuid::new_v4().to_string(),
            ];
            core.invoke(command(json!({
                "type": "gameWindowUpdate",
                "id": target_id,
                "input": {
                    "tabs": [{
                        "id": dormant_tab_ids[0],
                        "tabType": "role",
                        "sourceId": "saved-role-a",
                        "name": "Saved A",
                        "roleIds": ["saved-role-a"],
                        "hidden": false,
                        "audioMuted": true,
                        "roleViews": []
                    }, {
                        "id": dormant_tab_ids[2],
                        "tabType": "role",
                        "sourceId": "role-source",
                        "name": "Saved duplicate",
                        "roleIds": ["role-source"],
                        "hidden": false,
                        "audioMuted": false,
                        "roleViews": []
                    }, {
                        "id": dormant_tab_ids[1],
                        "tabType": "role",
                        "sourceId": "saved-role-b",
                        "name": "Saved B",
                        "roleIds": ["saved-role-b"],
                        "hidden": false,
                        "audioMuted": false,
                        "roleViews": []
                    }],
                    "activeTabId": dormant_tab_ids[0]
                }
            })))
            .unwrap();
            let launch_target = |window_id: &str| EmbeddedLaunchTargetRecord {
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
            let created = core
                .invoke_browser_runtime(BrowserRuntimeCommand::CreateTab {
                    tab_id: None,
                    source_id: "role-source".to_owned(),
                    name: "Role".to_owned(),
                    window_id: source_id.clone(),
                    tab_type: "role".to_owned(),
                    workspace_id: None,
                    role_ids: vec!["role-source".to_owned()],
                })
                .unwrap();
            let tab_id = created.created_tab_id.unwrap();
            core.sync_game_windows_from_runtime(
                &created.snapshot,
                &std::collections::HashSet::new(),
            )
            .unwrap();

            drive_async_command(
                Arc::clone(&core),
                CoreCommand::EmbeddedTabMove {
                    tab_id: tab_id.clone(),
                    target: launch_target(&target_id),
                },
                None,
            )
            .0
            .unwrap();

            let windows = core.invoke(CoreCommand::GameWindowsList).unwrap();
            assert_eq!(windows.as_array().unwrap().len(), 2, "{platform}");
            let source = windows
                .as_array()
                .unwrap()
                .iter()
                .find(|window| window["id"] == source_id)
                .unwrap();
            assert!(source["tabs"].as_array().unwrap().is_empty(), "{platform}");
            let target = windows
                .as_array()
                .unwrap()
                .iter()
                .find(|window| window["id"] == target_id)
                .unwrap();
            let target_sources = target["tabs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|tab| tab["sourceId"].as_str().unwrap())
                .collect::<Vec<_>>();
            assert_eq!(
                target_sources,
                ["saved-role-a", "role-source", "saved-role-b"],
                "{platform}"
            );
            assert_eq!(target["tabs"][1]["id"], tab_id, "{platform}");
            assert_eq!(target["activeTabId"], tab_id, "{platform}");
            let runtime = core.invoke(CoreCommand::BrowserRuntimeSnapshot).unwrap();
            assert!(
                runtime["windows"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|window| { window["windowId"].as_str() != Some(source_id.as_str()) })
            );

            let failed_id = uuid::Uuid::new_v4().to_string();
            let failed = drive_async_command(
                Arc::clone(&core),
                CoreCommand::EmbeddedTabMove {
                    tab_id: tab_id.clone(),
                    target: launch_target(&failed_id),
                },
                Some("other"),
            )
            .0;
            assert!(failed.is_err(), "{platform}");
            let windows = core.invoke(CoreCommand::GameWindowsList).unwrap();
            assert_eq!(windows.as_array().unwrap().len(), 2, "{platform}");
            assert!(
                windows
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|window| window["id"] == target_id),
                "{platform}"
            );

            let torn_out_id = uuid::Uuid::new_v4().to_string();
            drive_async_command(
                Arc::clone(&core),
                CoreCommand::EmbeddedTabMove {
                    tab_id,
                    target: launch_target(&torn_out_id),
                },
                None,
            )
            .0
            .unwrap();
            let windows = core.invoke(CoreCommand::GameWindowsList).unwrap();
            assert_eq!(windows.as_array().unwrap().len(), 2, "{platform}");
            let saved_target = windows
                .as_array()
                .unwrap()
                .iter()
                .find(|window| window["id"] == target_id)
                .unwrap();
            assert_eq!(
                saved_target["tabs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|tab| tab["sourceId"].as_str().unwrap())
                    .collect::<Vec<_>>(),
                ["saved-role-a", "saved-role-b"],
                "{platform}"
            );
            assert!(
                windows
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|window| window["id"].as_str() != Some(torn_out_id.as_str())),
                "{platform}"
            );
            core.shutdown();
        }
    }

    #[test]
    fn selecting_live_tabs_preserves_dormant_saved_tabs() {
        for platform in ["darwin", "win32"] {
            let (_directory, core) = core_for_platform(platform);
            let window_id = core
                .invoke(command(json!({
                    "type": "gameWindowCreate",
                    "input": {
                        "name": "Mixed live and dormant",
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
                .to_owned();
            let dormant_a = uuid::Uuid::new_v4().to_string();
            let dormant_b = uuid::Uuid::new_v4().to_string();
            core.invoke(command(json!({
                "type": "gameWindowUpdate",
                "id": window_id,
                "input": {
                    "tabs": [{
                        "id": dormant_a,
                        "tabType": "role",
                        "sourceId": "dormant-a",
                        "name": "Dormant A",
                        "roleIds": ["dormant-a"],
                        "hidden": false,
                        "audioMuted": true,
                        "roleViews": []
                    }, {
                        "id": dormant_b,
                        "tabType": "role",
                        "sourceId": "dormant-b",
                        "name": "Dormant B",
                        "roleIds": ["dormant-b"],
                        "hidden": false,
                        "audioMuted": false,
                        "roleViews": []
                    }],
                    "activeTabId": dormant_a
                }
            })))
            .unwrap();
            let create_live_tab = |source_id: &str| {
                core.invoke_browser_runtime(BrowserRuntimeCommand::CreateTab {
                    tab_id: None,
                    source_id: source_id.to_owned(),
                    name: source_id.to_owned(),
                    window_id: window_id.clone(),
                    tab_type: "role".to_owned(),
                    workspace_id: None,
                    role_ids: vec![source_id.to_owned()],
                })
                .unwrap()
            };
            let live_c = create_live_tab("live-c").created_tab_id.unwrap();
            let created_d = create_live_tab("live-d");
            let live_d = created_d.created_tab_id.unwrap();
            core.sync_game_windows_from_runtime(&created_d.snapshot, &HashSet::new())
                .unwrap();

            for selected in [&live_c, &live_d, &live_c] {
                core.invoke(CoreCommand::EmbeddedTabActivate {
                    tab_id: selected.clone(),
                })
                .unwrap();
            }

            let window = core
                .invoke(CoreCommand::GameWindowGet {
                    id: window_id.clone(),
                })
                .unwrap();
            assert_eq!(
                window["tabs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|tab| tab["sourceId"].as_str().unwrap())
                    .collect::<Vec<_>>(),
                ["dormant-a", "dormant-b", "live-c", "live-d"],
                "{platform}"
            );
            assert_eq!(window["activeTabId"], live_c, "{platform}");
            core.shutdown();
        }
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
                    zoom_factor: None,
                },
            );
            drive_accepted_launch_to_completion(
                Arc::clone(&core),
                CoreCommand::BrowserWorkspaceLaunch {
                    workspace_id: workspace_id.clone(),
                    target: target(&stopped_window_id),
                },
            );
            drive_accepted_launch_to_completion(
                Arc::clone(&core),
                CoreCommand::BrowserRoleLaunch {
                    role_id: other_role_id.clone(),
                    target: target(&other_window_id),
                    zoom_factor: None,
                },
            );
            drive_async_command(
                Arc::clone(&core),
                CoreCommand::BrowserWindowStop {
                    window_id: stopped_window_id.clone(),
                },
                None,
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
            assert!(
                runtime["windows"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|window| window["windowId"] != stopped_window_id),
                "{platform}"
            );
            assert!(
                runtime["windows"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|window| window["windowId"] == other_window_id),
                "{platform}"
            );
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
            assert_eq!(
                stopped_sources,
                HashSet::from([role_id.as_str(), workspace_id.as_str()]),
                "{platform}"
            );

            drive_accepted_launch_to_completion(
                Arc::clone(&core),
                CoreCommand::BrowserRoleLaunch {
                    role_id: role_id.clone(),
                    target: target(&stopped_window_id),
                    zoom_factor: None,
                },
            );
            drive_accepted_launch_to_completion(
                Arc::clone(&core),
                CoreCommand::BrowserWorkspaceLaunch {
                    workspace_id: workspace_id.clone(),
                    target: target(&stopped_window_id),
                },
            );
            let reopened = core.invoke(CoreCommand::BrowserRuntimeSnapshot).unwrap();
            let reopened_window = reopened["windows"]
                .as_array()
                .unwrap()
                .iter()
                .find(|window| window["windowId"] == stopped_window_id)
                .unwrap();
            assert_eq!(
                reopened_window["tabIds"].as_array().unwrap().len(),
                2,
                "{platform}"
            );
            drive_async_command(
                Arc::clone(&core),
                CoreCommand::BrowserWindowStop {
                    window_id: stopped_window_id.clone(),
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
                2,
                "{platform}"
            );

            let deleted_window_id = create_window("Delete together");
            drive_accepted_launch_to_completion(
                Arc::clone(&core),
                CoreCommand::BrowserRoleLaunch {
                    role_id: deleted_role_id,
                    target: target(&deleted_window_id),
                    zoom_factor: None,
                },
            );
            drive_async_command(
                Arc::clone(&core),
                CoreCommand::BrowserWindowDelete {
                    window_id: deleted_window_id.clone(),
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
                    role_id: failed_role_id,
                    target: target(&failed_window_id),
                    zoom_factor: None,
                },
            );
            let failed = drive_async_command(
                Arc::clone(&core),
                CoreCommand::BrowserWindowStop {
                    window_id: failed_window_id.clone(),
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
                1,
                "{platform}"
            );
            core.shutdown();
        }
    }

    #[test]
    fn runtime_game_window_projection_preserves_metadata_committed_while_waiting_for_the_guard() {
        let (_directory, core) = core();
        let window_id = core
            .invoke(command(json!({
                "type": "gameWindowCreate",
                "input": {
                    "name": "Original",
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
            .to_owned();
        core.invoke_browser_runtime(BrowserRuntimeCommand::RegisterWindow {
            window_id: window_id.clone(),
        })
        .unwrap();
        let snapshot = core
            .invoke_browser_runtime(BrowserRuntimeCommand::CreateTab {
                tab_id: None,
                source_id: "projection-role".to_owned(),
                name: "Projected role".to_owned(),
                window_id: window_id.clone(),
                tab_type: "role".to_owned(),
                workspace_id: None,
                role_ids: vec!["projection-role".to_owned()],
            })
            .unwrap()
            .snapshot;

        let guard = core.state_mutation_guard().unwrap();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let projection_core = Arc::clone(&core);
        let projection = thread::spawn(move || {
            started_tx.send(()).unwrap();
            projection_core.sync_game_windows_from_runtime(&snapshot, &HashSet::new())
        });
        started_rx.recv().unwrap();
        thread::sleep(Duration::from_millis(50));
        core.with_runtime(|runtime| {
            runtime.state.mutate(StateMutation::GameWindowUpdate {
                id: window_id.clone(),
                input: crate::model::GameWindowUpdateInputRecord {
                    name: Some("Concurrent edit".to_owned()),
                    ..Default::default()
                },
            })
        })
        .unwrap();
        drop(guard);
        projection.join().unwrap().unwrap();

        let persisted = core
            .invoke(CoreCommand::GameWindowGet {
                id: window_id.clone(),
            })
            .unwrap();
        assert_eq!(persisted["name"], "Concurrent edit");
        assert_eq!(persisted["tabs"][0]["sourceId"], "projection-role");
        core.shutdown();
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
