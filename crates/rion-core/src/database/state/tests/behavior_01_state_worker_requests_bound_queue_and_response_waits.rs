use std::fs;

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn state_worker_requests_bound_queue_and_response_waits() {
        let (blocked_sender, _blocked_receiver) = bounded::<Request>(0);
        let queue_error =
            request_with_timeout(&blocked_sender, Request::Snapshot, Duration::ZERO).unwrap_err();
        assert_eq!(queue_error.code(), "CORE_STATE_DATABASE_FAILED");
        assert!(queue_error.to_string().contains("queue timed out"));

        let (queued_sender, _queued_receiver) = bounded::<Request>(1);
        let response_error =
            request_with_timeout(&queued_sender, Request::Snapshot, Duration::ZERO).unwrap_err();
        assert_eq!(response_error.code(), "CORE_STATE_DATABASE_FAILED");
        assert!(response_error.to_string().contains("response timed out"));
    }

    #[test]
    fn browser_settings_no_longer_persist_retired_graphics_fields() {
        let directory = tempdir().unwrap();
        let database_path = directory.path().join("rion-studio.sqlite3");
        let worker = StateDatabaseWorker::start(database_path).unwrap();
        let stored = worker
            .read_scalar("gameBrowserSettings".to_owned())
            .unwrap()
            .unwrap();
        assert!(stored.get("graphics").is_none());
        assert_eq!(
            stored,
            serde_json::to_value(default_game_browser_settings()).unwrap()
        );
    }

    #[test]
    fn removed_browser_proxy_settings_are_not_created_or_accepted() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();
        let stored = connection
            .query_row(
                "SELECT payload_json FROM settings WHERE key='browserProxySettings'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .unwrap();
        assert!(stored.is_none());
        assert!(read_scalar(&connection, "browserProxySettings").is_err());
        assert!(replace_scalar(&mut connection, "browserProxySettings", json!({})).is_err());
    }

    #[test]
    fn runtime_game_window_save_commits_only_the_complete_record() {
        let directory = tempdir().unwrap();
        let database_path = directory.path().join("rion-studio.sqlite3");
        let worker = StateDatabaseWorker::start(database_path).unwrap();
        const SAVED_WINDOW_ID: &str = "00000000-0000-4000-8000-000000000001";
        const INVALID_WINDOW_ID: &str = "00000000-0000-4000-8000-000000000002";
        const ROLE_ID: &str = "00000000-0000-4000-8000-000000000003";
        const TAB_ID: &str = "00000000-0000-4000-8000-000000000004";
        const INVALID_TAB_ID_1: &str = "00000000-0000-4000-8000-000000000005";
        const INVALID_TAB_ID_2: &str = "00000000-0000-4000-8000-000000000006";
        let input = |window_id: &str, name: &str, duplicate_role: bool| {
            let tabs = if duplicate_role {
                json!([
                    {
                        "id": INVALID_TAB_ID_1, "tabType": "role", "sourceId": ROLE_ID,
                        "name": "Role 1", "roleIds": [ROLE_ID], "hidden": false,
                        "audioMuted": false, "roleViews": []
                    },
                    {
                        "id": INVALID_TAB_ID_2, "tabType": "role", "sourceId": ROLE_ID,
                        "name": "Role 1", "roleIds": [ROLE_ID], "hidden": false,
                        "audioMuted": false, "roleViews": []
                    }
                ])
            } else {
                json!([{
                    "id": TAB_ID, "tabType": "role", "sourceId": ROLE_ID,
                    "name": "Role 1", "roleIds": [ROLE_ID], "hidden": false,
                    "audioMuted": true,
                    "roleViews": [{
                        "roleId": ROLE_ID,
                        "rect": { "x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0 },
                        "browserZoomPercent": 125.0
                    }]
                }])
            };
            serde_json::from_value::<GameWindowSaveRuntimeInputRecord>(json!({
                "windowId": window_id,
                "name": name,
                "targetDisplay": { "id": 1 },
                "placement": {
                    "normalBounds": { "x": 20, "y": 30, "width": 960, "height": 640 },
                    "savedWorkArea": { "x": 0, "y": 0, "width": 1440, "height": 900 },
                    "presentation": "maximized"
                },
                "tabs": tabs,
                "activeTabId": if duplicate_role { INVALID_TAB_ID_1 } else { TAB_ID }
            }))
            .unwrap()
        };

        let saved = worker
            .mutate(StateMutation::GameWindowSaveRuntime(input(
                SAVED_WINDOW_ID,
                "Game Window 1",
                false,
            )))
            .unwrap();
        assert_eq!(saved["value"]["tabs"][0]["audioMuted"], true);
        assert_eq!(
            saved["value"]["tabs"][0]["roleViews"][0]["browserZoomPercent"],
            125.0
        );

        let error = worker
            .mutate(StateMutation::GameWindowSaveRuntime(input(
                INVALID_WINDOW_ID,
                "Game Window 2",
                true,
            )))
            .unwrap_err();
        assert_eq!(error.code(), "GAME_WINDOW_TAB_CONFLICT");
        let snapshot = worker.snapshot().unwrap();
        assert_eq!(snapshot["gameWindows"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["gameWindows"][0]["id"], SAVED_WINDOW_ID);
    }

    #[test]
    fn snapshot_round_trips_in_one_transaction() {
        let directory = tempdir().unwrap();
        let mut connection = Connection::open(directory.path().join("state.sqlite3")).unwrap();
        create_schema(&connection, false).unwrap();
        let snapshot = json!({
          "games": [{"id":"g1","name":"Game"}],
          "roles": [{"id":"r1","gameId":"g1","name":"Role"}],
          "launchWorkspaces": [{"id":"w1","name":"Workspace","slots":[{"id":"s1","roleId":"r1"}]}],
          "gameWindows": [],
          "macros": [{"id":"m1","name":"Macro","roleIds":["r1"],"steps":[]}],
          "logLevel": "debug"
        });
        replace_snapshot(&mut connection, &snapshot).unwrap();
        assert_eq!(read_snapshot(&connection).unwrap(), snapshot);
    }

    #[test]
    fn identical_snapshot_replace_preserves_revision() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();
        let snapshot = json!({
          "games": [{"id":"g1","name":"Game"}],
          "roles": [{"id":"r1","gameId":"g1","name":"Role"}],
          "launchWorkspaces": [],
          "macros": []
        });
        let revision = replace_snapshot(&mut connection, &snapshot).unwrap();
        let stored = read_snapshot(&connection).unwrap();

        let (unchanged_revision, changed) =
            replace_snapshot_if_changed(&mut connection, &stored).unwrap();

        assert!(!changed);
        assert_eq!(unchanged_revision, revision);
        assert_eq!(read_revision(&connection).unwrap(), revision);
        assert_eq!(read_snapshot(&connection).unwrap(), stored);
    }

    #[test]
    fn failed_replace_preserves_previous_snapshot() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();
        let valid = json!({"games":[{"id":"g1","name":"Game"}]});
        let revision = replace_snapshot(&mut connection, &valid).unwrap();
        let invalid = json!({"games":[{"name":"Missing id"}]});
        {
            assert!(replace_snapshot(&mut connection, &invalid).is_err());
            assert_eq!(read_revision(&connection).unwrap(), revision);
            assert_eq!(read_snapshot(&connection).unwrap()["games"][0]["id"], "g1");
            let retry = json!({"games":[{"id":"g2","name":"Retry"}]});
            replace_snapshot(&mut connection, &retry).unwrap();
            assert_eq!(read_snapshot(&connection).unwrap()["games"][0]["id"], "g2");
        };
    }

    #[test]
    fn foreign_key_failure_rolls_back_the_whole_snapshot() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();
        let valid = json!({"games":[{"id":"g1","name":"Game"}]});
        replace_snapshot(&mut connection, &valid).unwrap();
        let invalid = json!({
            "games":[{"id":"g2","name":"Other"}],
            "roles":[{"id":"r1","gameId":"missing","name":"Role"}]
        });

        assert!(replace_snapshot(&mut connection, &invalid).is_err());
        assert_eq!(read_snapshot(&connection).unwrap()["games"][0]["id"], "g1");
    }

    #[test]
    fn disk_full_during_snapshot_replace_rolls_back_the_transaction() {
        let directory = tempdir().unwrap();
        let database_path = directory.path().join("state.sqlite3");
        let mut connection = Connection::open(&database_path).unwrap();
        create_schema(&connection, false).unwrap();
        let original = json!({"games":[{"id":"g1","name":"Original"}]});
        replace_snapshot(&mut connection, &original).unwrap();
        connection.execute_batch("VACUUM").unwrap();
        let page_count: i64 = connection
            .query_row("PRAGMA page_count", [], |row| row.get(0))
            .unwrap();
        connection
            .pragma_update(None, "max_page_count", page_count)
            .unwrap();
        let oversized = json!({
            "games":[{"id":"g2","name":"x".repeat(2 * 1024 * 1024)}]
        });

        assert!(replace_snapshot(&mut connection, &oversized).is_err());
        assert_eq!(
            read_snapshot(&connection).unwrap()["games"],
            original["games"]
        );
    }

    #[test]
    fn ignores_retired_compatibility_reports_in_imported_snapshots() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();
        let original = json!({
            "games":[{"id":"g1","name":"Game"}],
            "compatibilityReports":[{"gameId":"g1","status":"compatible"}]
        });
        replace_snapshot(&mut connection, &original).unwrap();
        let stored = read_snapshot(&connection).unwrap();
        assert_eq!(stored["games"], original["games"]);
        assert!(stored.get("compatibilityReports").is_none());
    }

    #[test]
    fn replaces_one_scalar_state_field_without_rewriting_domain_tables() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();
        let original = json!({
            "games":[{
                "id":"g1","source":"custom","name":"Game",
                "defaultLaunchUrl":"https://example.test/play","browserEngine":"inherit",
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            }],
            "roles":[],"launchWorkspaces":[],"macros":[],"compatibilityReports":[],
            "gameBrowserSettings":{"browserEngine":"system"}
        });
        replace_snapshot(&mut connection, &original).unwrap();

        connection
            .execute_batch(
                "CREATE TRIGGER reject_game_delete BEFORE DELETE ON games
                 BEGIN SELECT RAISE(ABORT, 'domain table rewrite'); END;",
            )
            .unwrap();

        replace_scalar(
            &mut connection,
            "gameBrowserSettings",
            json!({"browserEngine":"system","marker":"replacement"}),
        )
        .unwrap();

        let stored = read_snapshot(&connection).unwrap();
        assert_eq!(stored["games"], original["games"]);
        assert_eq!(
            stored["gameBrowserSettings"],
            json!({"browserEngine":"system","marker":"replacement"})
        );
        assert!(replace_scalar(&mut connection, "games", json!([])).is_err());

        {
            let settings: GameBrowserSettingsRecord = serde_json::from_value(json!({
                "fonts":{
                    "mode":"custom",
                    "slots":{"monospace":{"source":"system","family":"  Courier   New  "}}
                },
                "graphics":{"mode":"automatic"},
                "browserEngine":"system",
                "macroBadgePosition":{
                    "horizontalAlign":"center","horizontalMarginPx":8,"topPx":128
                },
                "workspace":{"background":"material","gap":4}
            }))
            .unwrap();
            let settings = normalize_game_browser_settings(settings);
            assert!(!settings.performance.macos_high_refresh_rate);
            replace_scalar(
                &mut connection,
                "gameBrowserSettings",
                serde_json::to_value(&settings).unwrap(),
            )
            .unwrap();
            let stored: GameBrowserSettingsRecord = serde_json::from_value(
                read_scalar(&connection, "gameBrowserSettings")
                    .unwrap()
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(
                serde_json::to_value(&stored.fonts).unwrap()["slots"]["monospace"],
                json!({"source":"system","family":"Courier New"})
            );
            let mut changed_copy = stored.clone();
            changed_copy.fonts.slots.insert(
                "latin".to_owned(),
                serde_json::from_value(json!({"source":"system","family":"Changed"})).unwrap(),
            );
            let reloaded: GameBrowserSettingsRecord = serde_json::from_value(
                read_scalar(&connection, "gameBrowserSettings")
                    .unwrap()
                    .unwrap(),
            )
            .unwrap();
            assert!(!reloaded.fonts.slots.contains_key("latin"));
        };

        {
            let settings = normalize_macro_settings(MacroSettingsRecord {
                startup_delay_ms: 10_001,
                key_hold_ms: 1,
                post_input_delay_ms: 1,
                default_loop_delay_ms: 86_400_001,
            });
            replace_scalar(
                &mut connection,
                "macroSettings",
                serde_json::to_value(&settings).unwrap(),
            )
            .unwrap();
            let mut first: MacroSettingsRecord =
                serde_json::from_value(read_scalar(&connection, "macroSettings").unwrap().unwrap())
                    .unwrap();
            assert_eq!(first.key_hold_ms, 30);
            first.key_hold_ms = 999;
            assert_eq!(first.key_hold_ms, 999);
            let second: MacroSettingsRecord =
                serde_json::from_value(read_scalar(&connection, "macroSettings").unwrap().unwrap())
                    .unwrap();
            assert_eq!(second.key_hold_ms, 30);
        };

        {
            replace_scalar(
                &mut connection,
                "runtimeWindowPreferences",
                json!({
                    "alwaysHideTabCloseButton": true,
                    "alwaysShowToolbarInFullScreen": true
                }),
            )
            .unwrap();
            let reloaded: RuntimeWindowPreferencesRecord = serde_json::from_value(
                read_scalar(&connection, "runtimeWindowPreferences")
                    .unwrap()
                    .unwrap(),
            )
            .unwrap();
            assert!(reloaded.always_hide_tab_close_button);
            assert!(reloaded.always_show_toolbar_in_full_screen);
            assert!(reloaded.restore_game_windows_on_startup);
        };

        let restore_session = json!({
            "schemaVersion": 1,
            "updatedAt": "2026-07-25T00:00:00Z",
            "cleanExit": true,
            "lastFocusedWindowId": "window-1",
            "windows": [{
                "id": "window-1",
                "targetDisplay": {"id": 7},
                "wasVisible": true,
                "activeSourceId": "role-1",
                "tabs": [{
                    "tabType": "role",
                    "sourceId": "role-1",
                    "name": "Main",
                    "roleIds": ["role-1"],
                    "hidden": false,
                    "audioMuted": true
                }]
            }]
        });
        replace_scalar(
            &mut connection,
            "runtimeRestoreSession",
            restore_session.clone(),
        )
        .unwrap();
        assert_eq!(
            read_scalar(&connection, "runtimeRestoreSession")
                .unwrap()
                .unwrap(),
            restore_session
        );
    }

    #[test]
    fn game_and_role_crud_generate_identity_and_validate_relationships_in_rust() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();
        replace_snapshot(
            &mut connection,
            &json!({
                "games": [{
                    "id":"builtin-flyff-universe","source":"builtin","builtinKey":"flyff-universe",
                    "name":"Flyff Universe","defaultLaunchUrl":"https://universe.flyff.com/play",
                    "browserLaunchMode":"inherit","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                }],
                "roles": [], "launchWorkspaces": [], "macros": [], "compatibilityReports": []
            }),
        )
        .unwrap();

        let created_game = apply_domain_mutation(
            &mut connection,
            StateMutation::GameCreate(GameCreateInputRecord {
                name: "  Custom  ".to_owned(),
                default_launch_url: "https://example.test/play".to_owned(),
                icon_image_data_url: None,
                cover_image_data_url: None,
            }),
        )
        .unwrap();
        let game_id = created_game["value"]["id"].as_str().unwrap().to_owned();
        {
            assert_eq!(created_game["value"]["name"], "Custom");
            assert!(created_game["value"].get("browserEngine").is_none());
            assert!(created_game["value"].get("browserLaunchMode").is_none());
            assert_eq!(
                read_record(&connection, "games", &game_id)
                    .unwrap()
                    .unwrap()["name"],
                "Custom"
            );
            assert_eq!(
                connection
                    .query_row(
                        "SELECT COUNT(*) FROM games WHERE id=?1",
                        params![&game_id],
                        |row| row.get::<_, i64>(0)
                    )
                    .unwrap(),
                1
            );
        };

        let created_role = apply_domain_mutation(
            &mut connection,
            StateMutation::RoleCreate(RoleCreateInputRecord {
                game_id: game_id.clone(),
                name: "  Main  ".to_owned(),
                launch_url: Some("https://example.test/game".to_owned()),
                notes: None,
                cover_image_data_url: None,
                cover_image_dominant_color: None,
            }),
        )
        .unwrap();
        assert_eq!(created_role["value"]["name"], "Main");
        assert_eq!(created_role["value"]["gameId"], game_id);
        assert!(created_role["value"]["id"].as_str().unwrap().len() > 20);

        let error = apply_domain_mutation(
            &mut connection,
            StateMutation::GameDelete {
                id: game_id.clone(),
            },
        )
        .unwrap_err();
        assert_eq!(error.code(), "GAME_IN_USE");
        assert_eq!(
            read_snapshot(&connection).unwrap()["games"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn ordinary_crud_never_rewrites_unrelated_domain_tables() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();
        replace_snapshot(
            &mut connection,
            &json!({
                "games":[{
                    "id":"g1","source":"custom","name":"Game",
                    "defaultLaunchUrl":"https://example.test/play","browserLaunchMode":"inherit",
                    "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                }],
                "roles":[{
                    "id":"r1","gameId":"g1","name":"Role","launchUrl":"https://example.test/play",
                    "notes":"","browserSessionSource":"embedded",
                    "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                }],
                "launchWorkspaces":[],"macros":[],"compatibilityReports":[]
            }),
        )
        .unwrap();
        connection
            .execute_batch(
                "CREATE TRIGGER reject_unrelated_role_delete BEFORE DELETE ON roles
                 BEGIN SELECT RAISE(ABORT, 'unrelated role rewrite'); END;",
            )
            .unwrap();

        apply_domain_mutation(
            &mut connection,
            StateMutation::GameUpdate {
                id: "g1".to_owned(),
                input: GameUpdateInputRecord {
                    name: Some("Renamed".to_owned()),
                    ..GameUpdateInputRecord::default()
                },
            },
        )
        .unwrap();

        let snapshot = read_snapshot(&connection).unwrap();
        assert_eq!(snapshot["games"][0]["name"], "Renamed");
        assert_eq!(snapshot["roles"][0]["id"], "r1");
    }

    #[test]
    fn workspace_and_macro_inputs_are_normalized_and_related_in_rust() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();
        replace_snapshot(
            &mut connection,
            &json!({
                "games":[{
                    "id":"g1","source":"custom","name":"Game",
                    "defaultLaunchUrl":"https://example.test/play","browserLaunchMode":"inherit",
                    "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                }],
                "roles":[{
                    "id":"r1","gameId":"g1","name":"Role","launchUrl":"https://example.test/play",
                    "notes":"","browserSessionSource":"embedded",
                    "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                }],
                "launchWorkspaces":[],"macros":[],"compatibilityReports":[]
            }),
        )
        .unwrap();
        let workspace_input = serde_json::from_value(json!({
            "name":"  Party  ",
            "slots":[{"roleId":"r1"}]
        }))
        .unwrap();
        let workspace = apply_domain_mutation(
            &mut connection,
            StateMutation::WorkspaceCreate(workspace_input),
        )
        .unwrap();
        assert_eq!(workspace["value"]["name"], "Party");
        assert_eq!(workspace["value"]["template"], "two_columns");
        assert_eq!(workspace["value"]["slots"][0]["id"], "slot-1");

        let macro_input = serde_json::from_value(json!({
            "name":"  Buff  ",
            "roleIds":["r1", "r1"],
            "steps":[{"type":"key","code":" F1 ","modifiers":["shift", "shift"]}]
        }))
        .unwrap();
        let macro_record =
            apply_domain_mutation(&mut connection, StateMutation::MacroCreate(macro_input))
                .unwrap();
        assert_eq!(macro_record["value"]["name"], "Buff");
        assert_eq!(macro_record["value"]["roleIds"], json!(["r1"]));
        assert_eq!(macro_record["value"]["steps"][0]["code"], "F1");
        assert!(macro_record["value"]["steps"][0]["id"].is_string());

        let invalid = serde_json::from_value(json!({
            "name":"Invalid","roleIds":["missing"],
            "steps":[{"type":"delay","ms":1}]
        }))
        .unwrap();
        assert_eq!(
            apply_domain_mutation(&mut connection, StateMutation::MacroCreate(invalid))
                .unwrap_err()
                .code(),
            "MACRO_ROLE_ID_INVALID"
        );
    }

    #[test]
    fn role_delete_commits_relationship_cleanup_and_journal_phase_together() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();
        replace_snapshot(
            &mut connection,
            &json!({
                "games":[{
                    "id":"g1","source":"custom","name":"Game",
                    "defaultLaunchUrl":"https://example.test/play","browserLaunchMode":"inherit",
                    "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                }],
                "roles":[{
                    "id":"r1","gameId":"g1","name":"Role","launchUrl":"https://example.test/play",
                    "notes":"","browserSessionSource":"embedded",
                    "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                },{
                    "id":"r2","gameId":"g1","name":"Follower","launchUrl":"https://example.test/play",
                    "notes":"",
                    "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                }],
                "launchWorkspaces":[{
                    "id":"w1","name":"Workspace","template":"single","browserLaunchMode":"inherit",
                    "browserZoomMode":"fixed","browserZoomPercent":90,"resourcePolicy":{"mode":"unrestricted"},
                    "slots":[{"id":"slot-1","roleId":"r1","rect":{"x":0,"y":0,"width":1,"height":1}}],
                    "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                }],
                "macros":[{
                    "id":"m1","enabled":true,"activationMode":"toggle","name":"Macro","roleIds":["r1"],
                    "repeat":{"type":"once"},"steps":[{"type":"delay","id":"s1","ms":1}],
                    "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                }],
                "compatibilityReports":[]
            }),
        )
        .unwrap();
        put_operation_journal(
            &connection,
            &OperationJournalRecord {
                id: "role-delete-test".to_owned(),
                kind: "role_delete_v1".to_owned(),
                phase: "quarantined".to_owned(),
                payload: json!({"roleId":"r1"}),
            },
        )
        .unwrap();

        apply_domain_mutation(
            &mut connection,
            StateMutation::RoleDelete {
                id: "r1".to_owned(),
                operation_id: Some("role-delete-test".to_owned()),
            },
        )
        .unwrap();

        let snapshot = read_snapshot(&connection).unwrap();
        assert_eq!(snapshot["roles"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["roles"][0]["id"], "r2");
        assert!(snapshot["launchWorkspaces"][0]["slots"][0]["roleId"].is_null());
        assert!(
            snapshot["macros"][0]["roleIds"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT phase FROM operation_journal WHERE id='role-delete-test'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "committed"
        );
    }
