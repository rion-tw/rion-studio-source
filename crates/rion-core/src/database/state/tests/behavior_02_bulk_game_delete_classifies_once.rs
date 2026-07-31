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
                "DELETE FROM schema_migrations WHERE version=20;
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
            20
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
    fn schema_nineteen_upgrade_failure_rolls_back() {
        let connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();
        connection
            .execute_batch(
                "DELETE FROM schema_migrations WHERE version=20;
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
