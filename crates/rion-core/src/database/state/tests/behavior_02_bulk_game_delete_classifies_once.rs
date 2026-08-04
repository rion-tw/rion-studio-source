#[test]
    fn bulk_game_delete_classifies_once() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();
        replace_snapshot(
            &mut connection,
            &json!({
                "games":[
                    {
                        "id":"g-in-use","source":"custom","name":"In Use",
                        "defaultLaunchUrl":"https://example.test/in-use","browserLaunchMode":"inherit",
                        "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                    },
                    {
                        "id":"g-delete","source":"custom","name":"Delete",
                        "defaultLaunchUrl":"https://example.test/delete","browserLaunchMode":"inherit",
                        "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                    },
                    {
                        "id":"builtin-flyff-universe","source":"builtin","builtinKey":"flyff-universe",
                        "name":"Flyff Universe","defaultLaunchUrl":"https://universe.flyff.com/play",
                        "browserLaunchMode":"inherit","createdAt":"2026-01-01T00:00:00Z",
                        "updatedAt":"2026-01-01T00:00:00Z"
                    }
                ],
                "roles":[{
                    "id":"r1","gameId":"g-in-use","name":"Role","launchUrl":"https://example.test/in-use",
                    "notes":"","browserSessionSource":"embedded",
                    "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                }],
                "launchWorkspaces":[], "macros":[], "compatibilityReports":[]
            }),
        )
        .unwrap();
        let result = apply_domain_mutation(
            &mut connection,
            StateMutation::GamesDelete {
                ids: vec![
                    "g-in-use".to_owned(),
                    "g-delete".to_owned(),
                    "builtin-flyff-universe".to_owned(),
                    "missing".to_owned(),
                    "g-delete".to_owned(),
                ],
            },
        )
        .unwrap();

        assert_eq!(result["value"]["deletedIds"], json!(["g-delete"]));
        assert_eq!(
            result["value"]["skipped"],
            json!([
                {"id":"g-in-use","reason":"in_use","relatedNames":["Role"]},
                {"id":"builtin-flyff-universe","reason":"protected","relatedNames":[]},
                {"id":"missing","reason":"not_found","relatedNames":[]}
            ])
        );
    }

    #[test]
    fn rejects_a_database_created_by_a_newer_application_version() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
                 INSERT INTO schema_migrations(version, applied_at) VALUES (999, 'future');",
            )
            .unwrap();

        let error = create_schema(&connection, false).unwrap_err();
        assert_eq!(error.code(), "CORE_DATA_VERSION_UNSUPPORTED");
    }

    #[test]
    fn upgrades_schema_nineteen_atomically_and_preserves_current_data() {
        let connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();
        connection
            .execute_batch(
                "DELETE FROM schema_migrations WHERE version IN (24, 25);
                 INSERT INTO schema_migrations(version, applied_at) VALUES (19, 'current');
                 CREATE TABLE legacy_session_restores(id TEXT PRIMARY KEY);
                 INSERT INTO legacy_session_restores(id) VALUES ('retired');
                 INSERT INTO metadata(key, value) VALUES ('preserved', 'yes');",
            )
            .unwrap();

        create_schema(&connection, false).unwrap();

        assert_eq!(
            connection
                .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row
                    .get::<_, u32>(
                    0
                ))
                .unwrap(),
            25
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT value FROM metadata WHERE key='preserved'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "yes"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='legacy_session_restores'",
                    [],
                    |row| row.get::<_, u32>(0),
                )
                .unwrap(),
            0
        );
    }

    #[test]
    fn schema_twenty_three_adds_the_default_macro_shortcut_source_scope() {
        let connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();
        let payload = json!({
            "id": "macro-1",
            "name": "Legacy macro",
            "roleIds": ["role-1"],
            "trigger": {"code":"F2","ctrl":false,"alt":false,"shift":false,"meta":false}
        });
        connection
            .execute(
                "INSERT INTO macros(id, ordinal, name, payload_json) VALUES ('macro-1', 0, 'Legacy macro', ?1)",
                [serde_json::to_string(&payload).unwrap()],
            )
            .unwrap();
        connection
            .execute_batch(
                "DELETE FROM schema_migrations;
                 INSERT INTO schema_migrations(version, applied_at) VALUES (23, 'current');",
            )
            .unwrap();

        create_schema(&connection, false).unwrap();

        let migrated: Value = serde_json::from_str(
            &connection
                .query_row(
                    "SELECT payload_json FROM macros WHERE id='macro-1'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            migrated["shortcutSourceScope"],
            json!({"type":"all_execution_roles"})
        );
        assert_eq!(
            connection
                .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row.get::<_, u32>(0))
                .unwrap(),
            25
        );
    }

    #[test]
    fn schema_twenty_four_migrates_game_window_role_slots_with_stable_fallbacks() {
        let connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();
        let workspace_id = "10000000-0000-4000-8000-000000000001";
        let first_slot_id = "20000000-0000-4000-8000-000000000001";
        let second_slot_id = "20000000-0000-4000-8000-000000000002";
        let workspace = json!({
            "id": workspace_id,
            "name": "Legacy workspace",
            "template": "two_columns",
            "slots": [
                {
                    "id": first_slot_id,
                    "roleId": "role-1",
                    "browserZoomPercent": 110.0,
                    "rect": {"x":0.0,"y":0.0,"width":0.5,"height":1.0}
                },
                {
                    "id": second_slot_id,
                    "roleId": "role-2",
                    "browserZoomPercent": 125.0,
                    "rect": {"x":0.5,"y":0.0,"width":0.5,"height":1.0}
                }
            ],
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z"
        });
        connection
            .execute(
                "INSERT INTO workspaces(id, ordinal, name, payload_json) VALUES (?1, 0, ?2, ?3)",
                params![workspace_id, "Legacy workspace", serde_json::to_string(&workspace).unwrap()],
            )
            .unwrap();
        let game_window = json!({
            "id": "30000000-0000-4000-8000-000000000001",
            "name": "Legacy window",
            "targetDisplay": {"id": 1},
            "placement": {
                "normalBounds": {"x":0,"y":0,"width":1200,"height":800},
                "savedWorkArea": {"x":0,"y":0,"width":1440,"height":900},
                "presentation": "normal"
            },
            "tabs": [
                {
                    "id": "40000000-0000-4000-8000-000000000001",
                    "tabType": "workspace",
                    "sourceId": workspace_id,
                    "name": "Legacy workspace",
                    "roleIds": ["role-1", "role-2"],
                    "roleViews": [{
                        "roleId": "role-1",
                        "rect": {"x":0.1,"y":0.2,"width":0.3,"height":0.4},
                        "browserZoomPercent": 140.0
                    }],
                    "hidden": false,
                    "audioMuted": false
                },
                {
                    "id": "40000000-0000-4000-8000-000000000002",
                    "tabType": "role",
                    "sourceId": "role-3",
                    "name": "Legacy role",
                    "roleIds": ["role-3"],
                    "hidden": false,
                    "audioMuted": false
                }
            ],
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z"
        });
        connection
            .execute(
                "INSERT INTO game_windows(id, ordinal, name, payload_json) VALUES (?1, 0, ?2, ?3)",
                params![
                    "30000000-0000-4000-8000-000000000001",
                    "Legacy window",
                    serde_json::to_string(&game_window).unwrap()
                ],
            )
            .unwrap();
        connection
            .execute_batch(
                "DELETE FROM schema_migrations;
                 INSERT INTO schema_migrations(version, applied_at) VALUES (24, 'current');",
            )
            .unwrap();

        create_schema(&connection, false).unwrap();

        let migrated: Value = serde_json::from_str(
            &connection
                .query_row(
                    "SELECT payload_json FROM game_windows WHERE name='Legacy window'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
        )
        .unwrap();
        let workspace_tab = &migrated["tabs"][0];
        assert!(workspace_tab.get("roleIds").is_none());
        assert!(workspace_tab.get("roleViews").is_none());
        assert_eq!(workspace_tab["roleSlots"][0]["slotId"], first_slot_id);
        assert_eq!(
            workspace_tab["roleSlots"][0]["rect"],
            json!({"x":0.1,"y":0.2,"width":0.3,"height":0.4})
        );
        assert_eq!(workspace_tab["roleSlots"][0]["browserZoomPercent"], 140.0);
        assert_eq!(workspace_tab["roleSlots"][1]["slotId"], second_slot_id);
        assert_eq!(
            workspace_tab["roleSlots"][1]["rect"],
            json!({"x":0.5,"y":0.0,"width":0.5,"height":1.0})
        );
        assert_eq!(workspace_tab["roleSlots"][1]["browserZoomPercent"], 125.0);
        assert_eq!(migrated["tabs"][1]["roleSlots"][0]["slotId"], "legacy:0:role-3");
        assert_eq!(
            migrated["tabs"][1]["roleSlots"][0]["rect"],
            json!({"x":0.0,"y":0.0,"width":1.0,"height":1.0})
        );
        assert_eq!(
            connection
                .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row.get::<_, u32>(0))
                .unwrap(),
            25
        );
    }

    #[test]
    fn schema_nineteen_upgrade_failure_rolls_back() {
        let connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();
        connection
            .execute_batch(
                "DELETE FROM schema_migrations WHERE version IN (24, 25);
                 INSERT INTO schema_migrations(version, applied_at) VALUES (19, 'current');
                 CREATE TABLE legacy_session_restores(id TEXT PRIMARY KEY);
                 CREATE TRIGGER reject_schema_twenty BEFORE INSERT ON schema_migrations
                 WHEN NEW.version=20 BEGIN SELECT RAISE(ABORT, 'injected failure'); END;",
            )
            .unwrap();

        assert!(create_schema(&connection, false).is_err());
        assert_eq!(
            connection
                .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row
                    .get::<_, u32>(
                    0
                ))
                .unwrap(),
            19
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='legacy_session_restores'",
                    [],
                    |row| row.get::<_, u32>(0),
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn schemas_nineteen_through_twenty_two_remove_only_retired_sync_fields() {
        for schema in 19..=22 {
            let connection = Connection::open_in_memory().unwrap();
            create_schema(&connection, false).unwrap();
            let mut builtin: Value = serde_json::from_str(
                &connection
                    .query_row(
                        "SELECT payload_json FROM games WHERE id='builtin-flyff-universe'",
                        [],
                        |row| row.get::<_, String>(0),
                    )
                    .unwrap(),
            )
            .unwrap();
            builtin["localStorageSyncKeys"] = json!(["game_client_settings"]);
            builtin["localStorageSyncSelectors"] = json!(["audio"]);
            builtin["unknownGameField"] = json!({"preserved": true});
            connection
                .execute(
                    "UPDATE games SET payload_json=?1 WHERE id='builtin-flyff-universe'",
                    [serde_json::to_string(&builtin).unwrap()],
                )
                .unwrap();
            let custom = json!({
                "id": "custom-game",
                "source": "custom",
                "name": "Custom Game",
                "defaultLaunchUrl": "https://example.test/play",
                "browserLaunchMode": "inherit",
                "localStorageSyncKeys": ["custom-key"],
                "localStorageSyncSelectors": ["unknown-selector"],
                "unknownGameField": {"preserved": true},
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": "2026-01-01T00:00:00Z"
            });
            connection
                .execute(
                    "INSERT INTO games(id, ordinal, name, payload_json) VALUES (?1, 99, ?2, ?3)",
                    params![
                        "custom-game",
                        "Custom Game",
                        serde_json::to_string(&custom).unwrap()
                    ],
                )
                .unwrap();
            let role = json!({
                "id": "role-1",
                "gameId": "builtin-flyff-universe",
                "name": "Role",
                "launchUrl": "https://universe.flyff.com/play",
                "notes": "",
                "localStorageSourceRoleId": "source-role",
                "unknownRoleField": {"preserved": true},
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": "2026-01-01T00:00:00Z"
            });
            connection
                .execute(
                    "INSERT INTO roles(id, ordinal, game_id, name, payload_json) VALUES (?1, 0, ?2, ?3, ?4)",
                    params![
                        "role-1",
                        "builtin-flyff-universe",
                        "Role",
                        serde_json::to_string(&role).unwrap()
                    ],
                )
                .unwrap();
            connection.execute("DELETE FROM schema_migrations", []).unwrap();
            connection
                .execute(
                    "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, 'current')",
                    [schema],
                )
                .unwrap();
            if schema == 19 {
                connection
                    .execute_batch("CREATE TABLE legacy_session_restores(id TEXT PRIMARY KEY);")
                    .unwrap();
            }

            create_schema(&connection, false).unwrap();

            assert_eq!(
                connection
                    .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                        row.get::<_, u32>(0)
                    })
                    .unwrap(),
                25
            );
            for game_id in ["builtin-flyff-universe", "custom-game"] {
                let migrated_game: Value = serde_json::from_str(
                    &connection
                        .query_row(
                            "SELECT payload_json FROM games WHERE id=?1",
                            [game_id],
                            |row| row.get::<_, String>(0),
                        )
                        .unwrap(),
                )
                .unwrap();
                assert!(
                    migrated_game.get("localStorageSyncKeys").is_none(),
                    "schema {schema}, game {game_id}"
                );
                assert!(
                    migrated_game.get("localStorageSyncSelectors").is_none(),
                    "schema {schema}, game {game_id}"
                );
                assert_eq!(migrated_game["unknownGameField"]["preserved"], true);
            }
            let migrated_role: Value = serde_json::from_str(
                &connection
                    .query_row(
                        "SELECT payload_json FROM roles WHERE id='role-1'",
                        [],
                        |row| row.get::<_, String>(0),
                    )
                    .unwrap(),
            )
            .unwrap();
            assert!(migrated_role.get("localStorageSourceRoleId").is_none(), "schema {schema}");
            assert_eq!(migrated_role["unknownRoleField"]["preserved"], true);
        }
    }

    #[test]
    fn retired_sync_field_migration_failure_rolls_back_payloads_and_schema() {
        let connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();
        let payload = json!({
            "id": "builtin-flyff-universe",
            "localStorageSyncKeys": ["game_client_settings"],
            "localStorageSyncSelectors": ["audio"],
            "unknown": true
        });
        connection
            .execute(
                "UPDATE games SET payload_json=?1 WHERE id='builtin-flyff-universe'",
                [serde_json::to_string(&payload).unwrap()],
            )
            .unwrap();
        connection
            .execute_batch(
                "DELETE FROM schema_migrations;
                 INSERT INTO schema_migrations(version, applied_at) VALUES (22, 'current');
                 CREATE TRIGGER reject_schema_twenty_three BEFORE INSERT ON schema_migrations
                 WHEN NEW.version=23 BEGIN SELECT RAISE(ABORT, 'injected failure'); END;",
            )
            .unwrap();

        assert!(create_schema(&connection, false).is_err());

        assert_eq!(
            connection
                .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row.get::<_, u32>(0))
                .unwrap(),
            22
        );
        let unchanged: Value = serde_json::from_str(
            &connection
                .query_row(
                    "SELECT payload_json FROM games WHERE id='builtin-flyff-universe'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
        )
        .unwrap();
        assert!(unchanged.get("localStorageSyncKeys").is_some());
        assert!(unchanged.get("localStorageSyncSelectors").is_some());
        assert_eq!(unchanged["unknown"], true);
    }

    #[test]
    fn rejects_schema_eighteen_without_writes() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
                 INSERT INTO schema_migrations(version, applied_at) VALUES (18, 'retired');
                 CREATE TABLE sentinel(value TEXT NOT NULL);
                 INSERT INTO sentinel(value) VALUES ('preserve');",
            )
            .unwrap();
        let changes_before = connection.total_changes();

        let error = create_schema(&connection, false).unwrap_err();

        assert_eq!(error.code(), "CORE_DATA_VERSION_UNSUPPORTED");
        assert_eq!(connection.total_changes(), changes_before);
        assert_eq!(
            connection
                .query_row("SELECT value FROM sentinel", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "preserve"
        );
    }

    #[test]
    fn stores_images_as_blobs_and_restores_data_urls_at_the_api_boundary() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();
        let data_url = "data:image/png;base64,AQIDBA==";
        let snapshot = json!({
            "games": [{"id":"g1","name":"Game","iconImageDataUrl":data_url}],
            "roles": [{"id":"r1","gameId":"g1","name":"Role","coverImageDataUrl":data_url}]
        });

        replace_snapshot(&mut connection, &snapshot).unwrap();

        let game_payload: String = connection
            .query_row("SELECT payload_json FROM games", [], |row| row.get(0))
            .unwrap();
        let image_bytes: Vec<u8> = connection
            .query_row("SELECT data FROM game_images", [], |row| row.get(0))
            .unwrap();
        assert!(!game_payload.contains("base64"));
        assert_eq!(image_bytes, vec![1, 2, 3, 4]);
        let restored = read_snapshot(&connection).unwrap();
        assert_eq!(restored["games"], snapshot["games"]);
        assert_eq!(restored["roles"], snapshot["roles"]);
    }

    #[test]
    fn completes_a_committed_sqlite_portable_journal_before_state_is_exposed() {
        let directory = tempdir().unwrap();
        let database_path = directory.path().join("state.sqlite3");
        let connection = Connection::open(&database_path).unwrap();
        create_schema(&connection, false).unwrap();
        drop(connection);
        fs::create_dir_all(directory.path().join("portable-import-transaction.stage")).unwrap();
        fs::write(
            directory.path().join("portable-import-transaction.json"),
            r#"{
              "storageKind":"sqlite","phase":"committed","createdRoleIds":[],
              "games":[],"roles":[],"workspaces":[],"macros":[],
              "targetGames":[{"id":"g2","name":"Imported"}],
              "targetRoles":[],"targetWorkspaces":[],"targetMacros":[]
            }"#,
        )
        .unwrap();
        let worker = StateDatabaseWorker::start(database_path).unwrap();

        {
            assert!(
                worker
                    .recover_portable_import(directory.path().to_path_buf())
                    .unwrap()
            );
            assert_eq!(worker.snapshot().unwrap()["games"][0]["id"], "g2");
            assert!(
                !directory
                    .path()
                    .join("portable-import-transaction.json")
                    .exists()
            );
            assert!(
                !directory
                    .path()
                    .join("portable-import-transaction.stage")
                    .exists()
            );
        };
    }
