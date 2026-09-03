fn webview2_browser_version_json(runtime: &str) -> String {
    serde_json::json!({
        "protocolVersion": "1.3",
        "product": format!("Edg/{runtime}"),
        "revision": "@exact-revision",
        "userAgent": "exact-user-agent",
        "jsVersion": "exact-js-version"
    })
    .to_string()
}

fn webview2_cookie_json() -> Value {
    serde_json::json!({
        "name": "sid",
        "value": "secret",
        "domain": ".example.test",
        "path": "/",
        "expires": -1,
        "size": 9,
        "httpOnly": true,
        "secure": true,
        "session": true,
        "sameSite": "Lax",
        "priority": "Medium",
        "sourceScheme": "Secure",
        "sourcePort": 443
    })
}

fn webview2_storage_cookies_json(cookie: Value) -> String {
    serde_json::json!({ "cookies": [cookie] }).to_string()
}

fn webview2_test_journal() -> rion_core::RoleSessionMigrationRecord {
    rion_core::RoleSessionMigrationRecord {
        role_id: "11111111-1111-4111-8111-111111111111".to_owned(),
        transfer_id: "22222222-2222-4222-8222-222222222222".to_owned(),
        phase: rion_core::RoleSessionMigrationPhase::V22Ready,
        journal_revision: 7,
        platform: rion_core::RoleSessionMigrationPlatform::Windows,
        source_engine: rion_core::RoleSessionMigrationEngine::Webview2,
        target_engine: rion_core::RoleSessionMigrationEngine::Chromium,
        source_revision: 9,
        target_revision: None,
        envelope_sha256: None,
        inventory_sha256: None,
        cookie_count: None,
        local_storage_origin_count: None,
        local_storage_entry_count: None,
        stable_error_code: None,
        outcome: None,
        started_at: "2026-08-30T01:02:03Z".to_owned(),
        phase_changed_at: "2026-08-30T01:02:03Z".to_owned(),
        updated_at: "2026-08-30T01:02:03Z".to_owned(),
        outcome_at: None,
        first_verified_launch_at: None,
        clean_flush_receipt_id: None,
        reset_receipt_id: None,
    }
}

fn webview2_test_request() -> WindowsV22RoleSessionExportRequest {
    WindowsV22RoleSessionExportRequest {
        role_id: "11111111-1111-4111-8111-111111111111".to_owned(),
        transfer_id: "22222222-2222-4222-8222-222222222222".to_owned(),
        transition_id: "33333333-3333-4333-8333-333333333333".to_owned(),
        expected_source_revision: 9,
        expected_journal_revision: 7,
        occurred_at: "2026-08-30T01:02:03.000Z".to_owned(),
    }
}

fn webview2_test_evidence() -> rion_core::RoleSessionTransferJournalEvidence {
    rion_core::RoleSessionTransferJournalEvidence {
        role_id: "11111111-1111-4111-8111-111111111111".to_owned(),
        transfer_id: "22222222-2222-4222-8222-222222222222".to_owned(),
        envelope_sha256: "a".repeat(64),
        inventory_sha256: "b".repeat(64),
        cookie_count: 1,
        local_storage_origin_count: 2,
        local_storage_entry_count: 3,
    }
}

fn webview2_exported_test_journal() -> rion_core::RoleSessionMigrationRecord {
    let evidence = webview2_test_evidence();
    let mut journal = webview2_test_journal();
    journal.phase = rion_core::RoleSessionMigrationPhase::Exported;
    journal.journal_revision = 8;
    journal.envelope_sha256 = Some(evidence.envelope_sha256);
    journal.inventory_sha256 = Some(evidence.inventory_sha256);
    journal.cookie_count = Some(evidence.cookie_count);
    journal.local_storage_origin_count = Some(evidence.local_storage_origin_count);
    journal.local_storage_entry_count = Some(evidence.local_storage_entry_count);
    journal
}

fn webview2_failed_test_journal(
    retain_export_evidence: bool,
) -> rion_core::RoleSessionMigrationRecord {
    let mut journal = if retain_export_evidence {
        webview2_exported_test_journal()
    } else {
        let mut journal = webview2_test_journal();
        journal.journal_revision = 8;
        journal
    };
    journal.phase = rion_core::RoleSessionMigrationPhase::Failed;
    journal.stable_error_code = Some("ROLE_SESSION_TRANSFER_WEBVIEW2_CAPTURE_FAILED".to_owned());
    journal.outcome = Some(rion_core::RoleSessionMigrationOutcome::Failed);
    journal.outcome_at = Some("2026-08-30T01:02:04.000Z".to_owned());
    journal
}

#[test]
fn webview2_cookie_observation_maps_only_the_exact_canonical_hidden_attributes() {
    let observation = decode_webview2_export_observation(
        "98.0.4713.0",
        PathBuf::from("C:/role/Default"),
        &webview2_browser_version_json("98.0.4713.0"),
        &webview2_storage_cookies_json(webview2_cookie_json()),
    )
    .unwrap();
    assert_eq!(observation.cookies.len(), 1);
    let cookie = &observation.cookies[0];
    assert_eq!(cookie.domain, "example.test");
    assert!(!cookie.host_only);
    assert!(cookie.secure);
    assert_eq!(
        cookie.expiry,
        rion_core::RoleSessionTransferCookieExpiry::Session
    );
    assert_eq!(
        observation.source_evidence,
        rion_core::RoleSessionTransferSourceEvidenceRecord {
            kind: rion_core::RoleSessionTransferSourceEvidenceKind::Webview2StorageGetCookies,
            runtime_version: "98.0.4713.0".to_owned(),
            protocol_version: "1.3".to_owned(),
            partition_capability: rion_core::RoleSessionTransferCookiePartitionCapability::NetworkCookiePartitionKeyAndOpaque,
        }
    );

    let mut nonsecure = webview2_cookie_json();
    nonsecure["secure"] = false.into();
    nonsecure["sourceScheme"] = "NonSecure".into();
    nonsecure["sourcePort"] = 80.into();
    decode_webview2_export_observation(
        "98.0.4713.0",
        PathBuf::from("C:/role/Default"),
        &webview2_browser_version_json("98.0.4713.0"),
        &webview2_storage_cookies_json(nonsecure),
    )
    .unwrap();
}

#[test]
fn webview2_export_keeper_allows_only_the_opaque_blank_document() {
    assert!(webview2_export_keeper_navigation_allowed(
        &Url::parse("about:blank").unwrap()
    ));
    for identifiable in [
        "https://game.example.test",
        "http://game.example.test",
        "data:text/html,opaque",
        "about:srcdoc",
    ] {
        assert!(!webview2_export_keeper_navigation_allowed(
            &Url::parse(identifiable).unwrap()
        ));
    }
}

#[test]
fn webview2_cookie_future_fields_and_partition_evidence_fail_before_vault_materialization() {
    let mut future = webview2_cookie_json();
    future["futureCookieScope"] = "unknown".into();
    let error = decode_webview2_export_observation(
        "98.0.4713.0",
        PathBuf::new(),
        &webview2_browser_version_json("98.0.4713.0"),
        &webview2_storage_cookies_json(future),
    )
    .unwrap_err();
    assert_eq!(
        error.code,
        "ROLE_SESSION_TRANSFER_WEBVIEW2_COOKIE_OBSERVATION_INCOMPLETE"
    );
    assert!(!error.message.contains("futureCookieScope"));

    let mut partitioned = webview2_cookie_json();
    partitioned["partitionKey"] = serde_json::json!({
        "topLevelSite": "https://top.example.test",
        "hasCrossSiteAncestor": true
    });
    let error = decode_webview2_export_observation(
        "98.0.4713.0",
        PathBuf::new(),
        &webview2_browser_version_json("98.0.4713.0"),
        &webview2_storage_cookies_json(partitioned),
    )
    .unwrap_err();
    assert_eq!(
        error.code,
        "ROLE_SESSION_TRANSFER_COOKIE_PARTITION_UNSUPPORTED"
    );

    let mut opaque = webview2_cookie_json();
    opaque["partitionKeyOpaque"] = true.into();
    assert_eq!(
        decode_webview2_export_observation(
            "98.0.4713.0",
            PathBuf::new(),
            &webview2_browser_version_json("98.0.4713.0"),
            &webview2_storage_cookies_json(opaque),
        )
        .unwrap_err()
        .code,
        "ROLE_SESSION_TRANSFER_COOKIE_PARTITION_UNSUPPORTED"
    );
}

#[test]
fn webview2_cookie_priority_scheme_port_expiry_and_size_are_lossless_gates() {
    let cases = [
        ("priority", Value::String("High".to_owned())),
        ("sourceScheme", Value::String("Unset".to_owned())),
        ("sourcePort", Value::from(-1)),
        ("sourcePort", Value::from(8443)),
    ];
    for (field, value) in cases {
        let mut cookie = webview2_cookie_json();
        cookie[field] = value;
        assert_eq!(
            decode_webview2_export_observation(
                "98.0.4713.0",
                PathBuf::new(),
                &webview2_browser_version_json("98.0.4713.0"),
                &webview2_storage_cookies_json(cookie),
            )
            .unwrap_err()
            .code,
            "ROLE_SESSION_TRANSFER_WEBVIEW2_COOKIE_ATTRIBUTE_UNSUPPORTED"
        );
    }

    for (field, value) in [("expires", Value::from(0)), ("size", Value::from(99))] {
        let mut cookie = webview2_cookie_json();
        cookie[field] = value;
        assert_eq!(
            decode_webview2_export_observation(
                "98.0.4713.0",
                PathBuf::new(),
                &webview2_browser_version_json("98.0.4713.0"),
                &webview2_storage_cookies_json(cookie),
            )
            .unwrap_err()
            .code,
            "ROLE_SESSION_TRANSFER_WEBVIEW2_COOKIE_INVALID"
        );
    }
}

#[test]
fn webview2_partition_evidence_cutoff_protocol_and_product_identity_are_exact() {
    for runtime in ["97.0.4692.0", "098.0.4713.0", "98.0.4713", "future"] {
        assert_eq!(
            decode_webview2_export_observation(
                runtime,
                PathBuf::new(),
                &webview2_browser_version_json(runtime),
                r#"{"cookies":[]}"#,
            )
            .unwrap_err()
            .code,
            "ROLE_SESSION_TRANSFER_WEBVIEW2_RUNTIME_UNSUPPORTED"
        );
    }
    let mut version: Value =
        serde_json::from_str(&webview2_browser_version_json("98.0.4713.0")).unwrap();
    version["protocolVersion"] = "1.4".into();
    assert_eq!(
        decode_webview2_export_observation(
            "98.0.4713.0",
            PathBuf::new(),
            &version.to_string(),
            r#"{"cookies":[]}"#,
        )
        .unwrap_err()
        .code,
        "ROLE_SESSION_TRANSFER_WEBVIEW2_RUNTIME_UNSUPPORTED"
    );
}

#[test]
fn journal_plan_is_revision_fenced_idempotent_and_crash_resumable() {
    let mut journal = webview2_test_journal();
    let request = webview2_test_request();
    let evidence = webview2_test_evidence();
    assert_eq!(
        plan_webview2_source_export(&journal, &request, None).unwrap(),
        Webview2SourceExportPlan::Capture
    );
    assert_eq!(
        plan_webview2_source_export(&journal, &request, Some(&evidence)).unwrap(),
        Webview2SourceExportPlan::ResumePublishedVault
    );
    let transition = webview2_export_transition(&request, &evidence).unwrap();
    assert_eq!(transition.envelope_sha256, Some("a".repeat(64)));
    assert_eq!(transition.inventory_sha256, Some("b".repeat(64)));
    assert_eq!(transition.expected_journal_revision, 7);
    assert_eq!(transition.occurred_at, request.occurred_at);

    journal.phase = rion_core::RoleSessionMigrationPhase::Exported;
    assert_eq!(
        plan_webview2_source_export(&journal, &request, None).unwrap(),
        Webview2SourceExportPlan::VerifyExported
    );
    journal.journal_revision = 8;
    assert_eq!(
        plan_webview2_source_export(&journal, &request, None).unwrap(),
        Webview2SourceExportPlan::VerifyExported
    );
    let mut stale = request.clone();
    stale.expected_journal_revision += 2;
    assert_eq!(
        plan_webview2_source_export(&journal, &stale, None)
            .unwrap_err()
            .code,
        "ROLE_SESSION_TRANSFER_WEBVIEW2_JOURNAL_STALE"
    );
    let mut stale_source = request;
    stale_source.expected_source_revision += 1;
    assert_eq!(
        plan_webview2_source_export(&journal, &stale_source, None)
            .unwrap_err()
            .code,
        "ROLE_SESSION_TRANSFER_WEBVIEW2_JOURNAL_STALE"
    );
    stale_source.expected_source_revision -= 1;
    stale_source.occurred_at = "2026-08-30T01:02:03Z".to_owned();
    assert_eq!(
        plan_webview2_source_export(&journal, &stale_source, None)
            .unwrap_err()
            .code,
        "ROLE_SESSION_TRANSFER_WEBVIEW2_JOURNAL_STALE"
    );
}

#[test]
fn terminal_exported_replay_is_lagging_revision_safe_and_duplicate_idempotent() {
    use std::cell::Cell;

    let journal = webview2_exported_test_journal();
    let request = webview2_test_request();
    let evidence = webview2_test_evidence();
    let vault_reads = Cell::new(0_u32);
    let replay = || {
        replay_webview2_terminal_source_export(&journal, &request, || {
            vault_reads.set(vault_reads.get() + 1);
            Ok(evidence.clone())
        })
        .unwrap()
    };

    let first = replay();
    let duplicate = replay();
    assert_eq!(first, duplicate);
    assert_eq!(
        first,
        Webview2TerminalSourceExportReplay::Exported(evidence)
    );
    assert_eq!(vault_reads.get(), 2);
    assert_eq!(journal.journal_revision, 8);
    assert_eq!(request.expected_journal_revision, 7);
}

#[test]
fn terminal_failed_replay_validates_the_durable_receipt_without_a_vault_rewrite() {
    use std::cell::Cell;

    let journal = webview2_failed_test_journal(false);
    let request = webview2_test_request();
    let vault_reads = Cell::new(0_u32);
    let replay = || {
        replay_webview2_terminal_source_export(&journal, &request, || {
            vault_reads.set(vault_reads.get() + 1);
            Err(webview2_export_error(
                "UNEXPECTED_VAULT_READ",
                "A failed receipt without export evidence must not read a vault.",
            ))
        })
        .unwrap()
    };

    let first = replay();
    assert_eq!(first, replay());
    assert_eq!(vault_reads.get(), 0);
    assert_eq!(
        first,
        Webview2TerminalSourceExportReplay::Failed {
            stable_error_code: "ROLE_SESSION_TRANSFER_WEBVIEW2_CAPTURE_FAILED".to_owned(),
            evidence: None,
        }
    );
    assert_eq!(journal.journal_revision, 8);
    assert_eq!(request.expected_journal_revision, 7);
}

#[test]
fn terminal_replay_fails_closed_for_missing_corrupt_or_mismatched_vault() {
    let journal = webview2_exported_test_journal();
    let request = webview2_test_request();
    for code in [
        "ROLE_SESSION_TRANSFER_VAULT_NOT_FOUND",
        "ROLE_SESSION_TRANSFER_VAULT_AUTHENTICATION_FAILED",
    ] {
        let error = replay_webview2_terminal_source_export(&journal, &request, || {
            Err(RuntimeError::new(code, "Vault verification failed."))
        })
        .unwrap_err();
        assert_eq!(error.code, code);
        assert!(!error.message.contains("secret"));
    }

    let mut mismatched = webview2_test_evidence();
    mismatched.envelope_sha256 = "c".repeat(64);
    let error =
        replay_webview2_terminal_source_export(&journal, &request, || Ok(mismatched)).unwrap_err();
    assert_eq!(error.code, "ROLE_SESSION_TRANSFER_WEBVIEW2_EVIDENCE_STALE");

    let failed_with_vault = webview2_failed_test_journal(true);
    assert_eq!(
        replay_webview2_terminal_source_export(&failed_with_vault, &request, || Err(
            RuntimeError::new(
                "ROLE_SESSION_TRANSFER_VAULT_NOT_FOUND",
                "Vault verification failed.",
            )
        ))
        .unwrap_err()
        .code,
        "ROLE_SESSION_TRANSFER_VAULT_NOT_FOUND"
    );

    let mut malformed_failure = webview2_failed_test_journal(false);
    malformed_failure.outcome_at = None;
    assert_eq!(
        replay_webview2_terminal_source_export(&malformed_failure, &request, || {
            unreachable!("an invalid durable failure receipt cannot authorize a vault read")
        })
        .unwrap_err()
        .code,
        "ROLE_SESSION_TRANSFER_WEBVIEW2_TERMINAL_RECEIPT_INVALID"
    );
}

#[cfg(unix)]
#[test]
fn exact_default_profile_path_rejects_symlink_escape() {
    use std::os::unix::fs::symlink;

    let directory = tempfile::tempdir().unwrap();
    let user_data = directory.path().join("udf");
    let profile = user_data.join("Default");
    std::fs::create_dir_all(&profile).unwrap();
    validate_webview2_export_profile_path(&user_data, &profile).unwrap();

    let outside = tempfile::tempdir().unwrap();
    let linked = directory.path().join("linked-udf");
    symlink(outside.path(), &linked).unwrap();
    assert_eq!(
        validate_webview2_export_profile_path(&linked, outside.path().join("Default").as_path())
            .unwrap_err()
            .code,
        "ROLE_SESSION_TRANSFER_WEBVIEW2_PROFILE_IDENTITY_INVALID"
    );
}

#[test]
fn privileged_native_export_source_has_no_external_or_renderer_protocol_surface() {
    let source = include_str!("../platform/windows/session_export.rs");
    let coordinator = include_str!("../section_29_windows_role_session_export.rs");
    let startup = include_str!("../../lib/section_09_run.rs");
    assert!(source.contains("Browser.getVersion"));
    assert!(source.contains("Storage.getCookies"));
    assert!(source.contains("CallDevToolsProtocolMethod"));
    for forbidden in [
        "remote-debugging",
        "TcpStream",
        "WebSocket",
        "http://",
        "https://",
        "window.rionStudio",
        "recv_timeout",
        "tokio::time",
        "thread::sleep",
    ] {
        assert!(
            !source.contains(forbidden),
            "forbidden native source: {forbidden}"
        );
    }
    assert!(!source.contains("pub fn call_windows_webview2_export_protocol_method"));
    assert!(coordinator.contains("recoverableMutation"));
    assert!(coordinator.contains("acquire_browser_operation"));
    assert!(coordinator.contains("pending_role_session_transfer_vault_evidence_internal"));
    assert!(coordinator.contains("replay_webview2_terminal_source_export"));
    assert!(coordinator.contains("schedule_windows_v22_role_session_export_resume"));
    assert!(startup.contains("prepare_v22_role_session_migrations_internal"));
    assert!(startup.contains("schedule_windows_v22_role_session_export_resume"));
    assert_eq!(
        coordinator
            .matches(".transition_role_session_migration(")
            .count(),
        2,
        "only v22Ready publication paths may write a migration transition"
    );
    assert!(!coordinator.contains("#[tauri::command]"));
    assert!(!coordinator.contains("window.rionStudio"));
    assert!(!coordinator.contains("start_role_session_migration"));
    for forbidden in [
        "eprintln!",
        "println!",
        "dbg!",
        "tracing::",
        "log::",
        "recv_timeout",
        "tokio::time",
        "thread::sleep",
    ] {
        assert!(
            !coordinator.contains(forbidden),
            "terminal replay must not log secrets or infer completion: {forbidden}"
        );
    }
}

#[cfg(windows)]
#[test]
fn windows_gated_export_fixture_requires_durable_partition_capability_evidence() {
    let observation = decode_webview2_export_observation(
        "98.0.4713.0",
        PathBuf::from(r"C:\role\Default"),
        &webview2_browser_version_json("98.0.4713.0"),
        r#"{"cookies":[]}"#,
    )
    .unwrap();
    assert_eq!(
        observation.source_evidence.partition_capability,
        rion_core::RoleSessionTransferCookiePartitionCapability::NetworkCookiePartitionKeyAndOpaque
    );
}
