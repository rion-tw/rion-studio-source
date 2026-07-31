use serde_json::json;
    use tempfile::tempdir;

    use super::*;
    use crate::model::{LogCaptureRecord, LogSource};

    #[test]
    fn log_worker_requests_bound_queue_and_response_waits() {
        let (blocked_sender, _blocked_receiver) = bounded::<Request>(0);
        let queue_error =
            request_with_timeout(&blocked_sender, Request::Status, Duration::ZERO).unwrap_err();
        assert_eq!(queue_error.code(), "CORE_LOG_DATABASE_FAILED");
        assert!(queue_error.to_string().contains("queue timed out"));

        let (queued_sender, _queued_receiver) = bounded::<Request>(1);
        let response_error =
            request_with_timeout(&queued_sender, Request::Status, Duration::ZERO).unwrap_err();
        assert_eq!(response_error.code(), "CORE_LOG_DATABASE_FAILED");
        assert!(response_error.to_string().contains("response timed out"));
    }

    fn entry(id: &str, message: &str) -> LogEntry {
        LogEntry {
            id: id.to_owned(),
            timestamp: Utc::now().to_rfc3339(),
            level: LogLevel::Info,
            source: LogSource::Main,
            event: "test".to_owned(),
            message: message.to_owned(),
            session_id: "session".to_owned(),
            context: None,
            error: None,
        }
    }

    fn entry_at(id: &str, message: &str, timestamp: chrono::DateTime<Utc>) -> LogEntry {
        let mut value = entry(id, message);
        value.timestamp = timestamp.to_rfc3339();
        value
    }

    #[test]
    fn appends_and_queries_without_loading_files() {
        let directory = tempdir().unwrap();
        let mut connection = Connection::open(directory.path().join("logs.sqlite3")).unwrap();
        create_schema(&connection, false).unwrap();
        let mut browser = entry("1", "alpha role");
        browser.source = LogSource::Browser;
        browser.context = Some(BTreeMap::from([
            ("roleId".to_owned(), json!("role-1")),
            ("token".to_owned(), json!("<REDACTED>")),
        ]));
        let mut warning = entry("2", "beta macro");
        warning.level = LogLevel::Warn;
        warning.source = LogSource::Macro;
        append_entries(
            &mut connection,
            &[browser.clone(), warning.clone(), entry("3", "gamma role")],
        )
        .unwrap();
        {
            let filtered = query_entries(
                &connection,
                &LogQuery {
                    sources: Some(vec![LogSource::Browser]),
                    limit: Some(1),
                    ..LogQuery::default()
                },
            )
            .unwrap();
            assert_eq!(filtered.entries.len(), 1);
            assert_eq!(filtered.entries[0].id, browser.id);
            assert_eq!(filtered.entries[0].context, browser.context);
            let first = query_entries(
                &connection,
                &LogQuery {
                    limit: Some(1),
                    ..LogQuery::default()
                },
            )
            .unwrap();
            assert_eq!(first.entries.len(), 1);
            assert_eq!(first.next_cursor.as_deref(), Some("1"));
            let second = query_entries(
                &connection,
                &LogQuery {
                    cursor: first.next_cursor,
                    limit: Some(1),
                    ..LogQuery::default()
                },
            )
            .unwrap();
            assert_eq!(second.entries.len(), 1);
            assert_ne!(first.entries[0].id, second.entries[0].id);
            let searched = query_entries(
                &connection,
                &LogQuery {
                    search: Some("beta".to_owned()),
                    ..LogQuery::default()
                },
            )
            .unwrap();
            assert_eq!(searched.entries.len(), 1);
            assert_eq!(searched.entries[0].id, warning.id);
            let status = read_status(&connection, &directory.path().join("logs.sqlite3")).unwrap();
            assert_eq!(status.entry_count, 3);
            assert_eq!(status.file_count, 1);
            assert!(status.total_bytes > 0);
        };
    }

    #[test]
    fn sqlite_and_jsonl_preserve_launch_error_and_setup_context() {
        let directory = tempdir().unwrap();
        let mut connection = Connection::open(directory.path().join("logs.sqlite3")).unwrap();
        create_schema(&connection, false).unwrap();
        let mut launch_error = entry("setup-failure", "WebView2 setup failed");
        launch_error.level = LogLevel::Error;
        launch_error.source = LogSource::Browser;
        launch_error.event = "tab.launch-settled".to_owned();
        launch_error.context = Some(BTreeMap::from([
            ("setupStage".to_owned(), json!("permission-handler")),
            ("nativeCode".to_owned(), json!("0x8007139F")),
        ]));
        launch_error.error = Some(LogErrorDetails {
            name: "SYSTEM_ROLE_SETUP_FAILED".to_owned(),
            message: "WebView2 setup failed".to_owned(),
            stack: None,
            cause: None,
        });
        append_entries(&mut connection, std::slice::from_ref(&launch_error)).unwrap();

        let stored = query_entries(&connection, &LogQuery::default()).unwrap();
        assert_eq!(stored.entries[0].error, launch_error.error);
        assert_eq!(stored.entries[0].context, launch_error.context);

        let mut exported = Vec::new();
        write_jsonl(&connection, &mut exported).unwrap();
        let exported: Value = serde_json::from_slice(
            String::from_utf8(exported)
                .unwrap()
                .lines()
                .next()
                .unwrap()
                .as_bytes(),
        )
        .unwrap();
        assert_eq!(exported["error"]["name"], "SYSTEM_ROLE_SETUP_FAILED");
        assert_eq!(exported["error"]["message"], "WebView2 setup failed");
        assert_eq!(exported["context"]["setupStage"], "permission-handler");
        assert_eq!(exported["context"]["nativeCode"], "0x8007139F");
    }

    #[test]
    fn reclaims_fragmented_empty_database_without_deleting_the_newest_entry() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("logs.sqlite3");
        let mut connection = Connection::open(&path).unwrap();
        create_schema(&connection, false).unwrap();
        let oversized = (0..160)
            .map(|index| {
                entry(
                    &format!("fragment-{index:03}"),
                    &format!("fragment-{index:03} {}", "x".repeat(8 * 1024)),
                )
            })
            .collect::<Vec<_>>();
        append_entries(&mut connection, &oversized).unwrap();
        connection.execute("DELETE FROM log_entries", []).unwrap();

        let policy = RetentionPolicy {
            retention_days: RETENTION_DAYS,
            max_bytes: 512 * 1024,
            target_bytes: 384 * 1024,
            delete_batch_size: 10,
        };
        assert!(database_size(&connection).unwrap() > policy.max_bytes);

        let newest = entry("app-session-started", "Application logging started.");
        append_entries_with_policy(&mut connection, std::slice::from_ref(&newest), policy).unwrap();

        let page = query_entries(
            &connection,
            &LogQuery {
                search: Some("Application logging started".to_owned()),
                ..LogQuery::default()
            },
        )
        .unwrap();
        assert_eq!(
            page.entries
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            ["app-session-started"]
        );
        let reclaimed_size = database_size(&connection).unwrap();
        let reclaimed_free: i64 = connection
            .query_row("PRAGMA freelist_count", [], |row| row.get(0))
            .unwrap();
        let auto_vacuum: i64 = connection
            .query_row("PRAGMA auto_vacuum", [], |row| row.get(0))
            .unwrap();
        assert!(
            reclaimed_size <= policy.max_bytes,
            "reclaimed size={reclaimed_size}, freelist={reclaimed_free}, auto_vacuum={auto_vacuum}"
        );

        let mut exported = Vec::new();
        write_jsonl(&connection, &mut exported).unwrap();
        let exported = String::from_utf8(exported).unwrap();
        assert!(exported.contains("\"id\":\"app-session-started\""));
        assert!(!exported.contains("\"id\":\"fragment-"));
    }

    #[test]
    fn capacity_retention_prunes_oldest_entries_to_target_and_keeps_fts_and_export_valid() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("logs.sqlite3");
        let mut connection = Connection::open(&path).unwrap();
        create_schema(&connection, false).unwrap();
        let now = Utc::now();
        let entries = (0..96)
            .map(|index| {
                entry_at(
                    &format!("entry-{index:03}"),
                    &format!("unique-{index:03} {}", "y".repeat(8 * 1024)),
                    now + ChronoDuration::seconds(index),
                )
            })
            .collect::<Vec<_>>();
        let policy = RetentionPolicy {
            retention_days: RETENTION_DAYS,
            max_bytes: 512 * 1024,
            target_bytes: 384 * 1024,
            delete_batch_size: 10,
        };

        append_entries_with_policy(&mut connection, &entries, policy).unwrap();

        let remaining = query_entries(
            &connection,
            &LogQuery {
                limit: Some(200),
                ..LogQuery::default()
            },
        )
        .unwrap()
        .entries;
        assert!(!remaining.is_empty());
        assert!(remaining.len() < entries.len());
        assert_eq!(remaining[0].id, "entry-095");
        assert!(!remaining.iter().any(|entry| entry.id == "entry-000"));
        let retained_size = database_size(&connection).unwrap();
        let retained_free: i64 = connection
            .query_row("PRAGMA freelist_count", [], |row| row.get(0))
            .unwrap();
        assert!(
            retained_size <= policy.target_bytes,
            "retained size={retained_size}, freelist={retained_free}, entries={}",
            remaining.len()
        );

        let searched = query_entries(
            &connection,
            &LogQuery {
                search: Some("unique-095".to_owned()),
                limit: Some(1),
                ..LogQuery::default()
            },
        )
        .unwrap();
        assert_eq!(searched.entries[0].id, "entry-095");

        let post_rebuild = (0..3)
            .map(|index| {
                entry_at(
                    &format!("post-rebuild-{index}"),
                    &format!("post rebuild {index}"),
                    now + ChronoDuration::seconds(200 + index),
                )
            })
            .collect::<Vec<_>>();
        append_entries_with_policy(&mut connection, &post_rebuild, policy).unwrap();
        let first_page = query_entries(
            &connection,
            &LogQuery {
                limit: Some(2),
                ..LogQuery::default()
            },
        )
        .unwrap();
        assert_eq!(first_page.entries.len(), 2);
        assert_eq!(first_page.next_cursor.as_deref(), Some("2"));
        let second_page = query_entries(
            &connection,
            &LogQuery {
                cursor: first_page.next_cursor,
                limit: Some(2),
                ..LogQuery::default()
            },
        )
        .unwrap();
        assert!(!second_page.entries.is_empty());

        let mut exported = Vec::new();
        write_jsonl(&connection, &mut exported).unwrap();
        let exported = String::from_utf8(exported).unwrap();
        assert!(exported.contains("\"id\":\"entry-095\""));
        assert!(exported.contains("\"id\":\"post-rebuild-2\""));
        assert!(!exported.contains("\"id\":\"entry-000\""));
    }

    #[test]
    fn age_retention_removes_expired_entries_but_preserves_current_entries() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("logs.sqlite3");
        let mut connection = Connection::open(&path).unwrap();
        create_schema(&connection, false).unwrap();
        let entries = [
            entry_at(
                "expired",
                "expired event",
                Utc::now() - ChronoDuration::days(RETENTION_DAYS + 1),
            ),
            entry("current", "current event"),
        ];

        append_entries_with_policy(
            &mut connection,
            &entries,
            RetentionPolicy {
                max_bytes: i64::MAX,
                target_bytes: i64::MAX,
                ..RetentionPolicy::default()
            },
        )
        .unwrap();

        let remaining = query_entries(&connection, &LogQuery::default())
            .unwrap()
            .entries;
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, "current");
    }

    #[test]
    fn default_level_clear_and_query_validation() {
        {
            let directory = tempdir().unwrap();
            let path = directory.path().join("logs.sqlite3");
            let mut connection = Connection::open(&path).unwrap();
            create_schema(&connection, false).unwrap();
            let mut capture =
                crate::log_capture::LogCaptureRuntime::new(directory.path().into(), LogLevel::Info);
            let hidden = capture.capture(vec![LogCaptureRecord {
                level: LogLevel::Debug,
                source: LogSource::Main,
                event: "hidden".to_owned(),
                message: "Hidden debug message.".to_owned(),
                context_raw_json: None,
                error: None,
            }]);
            assert!(hidden.is_empty());
            capture.set_level(LogLevel::Debug);
            let visible = capture.capture(vec![LogCaptureRecord {
                level: LogLevel::Debug,
                source: LogSource::Main,
                event: "visible".to_owned(),
                message: "Visible debug message.".to_owned(),
                context_raw_json: None,
                error: None,
            }]);
            append_entries(&mut connection, &visible).unwrap();
            assert_eq!(
                query_entries(&connection, &LogQuery::default())
                    .unwrap()
                    .entries[0]
                    .event,
                "visible"
            );
            clear_entries(&connection).unwrap();
            assert!(
                query_entries(&connection, &LogQuery::default())
                    .unwrap()
                    .entries
                    .is_empty()
            );
        };

        {
            let connection = Connection::open_in_memory().unwrap();
            create_schema(&connection, false).unwrap();
            assert!(
                query_entries(
                    &connection,
                    &LogQuery {
                        limit: Some(201),
                        ..LogQuery::default()
                    }
                )
                .is_err()
            );
            assert!(
                query_entries(
                    &connection,
                    &LogQuery {
                        cursor: Some("../file".to_owned()),
                        ..LogQuery::default()
                    }
                )
                .is_err()
            );
            assert!(
                query_entries(
                    &connection,
                    &LogQuery {
                        search: Some("x".repeat(201)),
                        ..LogQuery::default()
                    }
                )
                .is_err()
            );
        };
    }

    #[test]
    fn worker_acknowledges_only_durable_appends() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("logs.sqlite3");
        let mut worker = LogDatabaseWorker::start(path.clone()).unwrap();
        worker.append(vec![entry("info", "queued")]).unwrap();
        let reader = Connection::open(&path).unwrap();
        assert_eq!(
            reader
                .query_row("SELECT COUNT(*) FROM log_entries", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            1,
            "append must not acknowledge entries before their transaction commits"
        );
        let mut warning = entry("warn", "urgent");
        warning.level = LogLevel::Warn;
        worker.append(vec![warning]).unwrap();

        assert_eq!(
            reader
                .query_row("SELECT COUNT(*) FROM log_entries", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            2
        );

        worker.append(vec![entry("later", "pending")]).unwrap();
        let status = worker.status().unwrap();
        assert_eq!(status.entry_count, 3);
        assert!(status.file_count >= 1);
        assert!(status.total_bytes > 0);
        let storage = worker.storage_status(LogLevel::Info).unwrap();
        assert_eq!(storage.entry_count, 3);
        assert_eq!(storage.file_count, status.file_count);
        worker.shutdown().unwrap();
    }

    #[test]
    fn worker_flushes_the_bounded_queue_during_shutdown() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("logs.sqlite3");
        let mut worker = LogDatabaseWorker::start(path.clone()).unwrap();
        let (response_sender, response_receiver) = bounded(1);
        worker
            .sender
            .send(Request::Append(
                vec![entry("shutdown", "pending")],
                response_sender,
            ))
            .unwrap();
        worker.shutdown().unwrap();
        assert_eq!(response_receiver.recv().unwrap().unwrap(), 1);

        let connection = Connection::open(path).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM log_entries", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            1
        );
    }

    #[test]
    fn worker_shutdown_propagates_flush_failures() {
        let (sender, receiver) = bounded(1);
        let join = thread::spawn(move || {
            let Request::Shutdown(response) = receiver.recv().unwrap() else {
                panic!("expected shutdown request");
            };
            let _ = response.send(Err(CoreError::LogDatabase("flush failed".to_owned())));
        });
        let mut worker = LogDatabaseWorker {
            sender,
            join: Some(join),
        };

        let error = worker.shutdown().unwrap_err();

        assert_eq!(error.code(), "CORE_LOG_DATABASE_FAILED");
        assert!(error.to_string().contains("flush failed"));
    }
