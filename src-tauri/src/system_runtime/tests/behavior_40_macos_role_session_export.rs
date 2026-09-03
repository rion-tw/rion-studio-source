fn wkwebview_test_journal() -> rion_core::RoleSessionMigrationRecord {
    rion_core::RoleSessionMigrationRecord {
        role_id: "11111111-1111-4111-8111-111111111111".to_owned(),
        transfer_id: "22222222-2222-4222-8222-222222222222".to_owned(),
        phase: rion_core::RoleSessionMigrationPhase::V22Ready,
        journal_revision: 7,
        platform: rion_core::RoleSessionMigrationPlatform::Macos,
        source_engine: rion_core::RoleSessionMigrationEngine::Wkwebview,
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

fn wkwebview_test_request() -> MacosV22RoleSessionExportRequest {
    MacosV22RoleSessionExportRequest {
        role_id: "11111111-1111-4111-8111-111111111111".to_owned(),
        transfer_id: "22222222-2222-4222-8222-222222222222".to_owned(),
        transition_id: "33333333-3333-4333-8333-333333333333".to_owned(),
        expected_source_revision: 9,
        expected_journal_revision: 7,
        occurred_at: "2026-08-30T01:02:03.000Z".to_owned(),
    }
}

fn wkwebview_test_evidence() -> rion_core::RoleSessionTransferJournalEvidence {
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

#[test]
fn wkwebview_public_api_blockers_are_independent_and_always_deny_a_vault() {
    let cookie_only = MacosWkRoleSessionPublicObservation {
        cookie_count: 2,
        http_only_cookie_count: 1,
        local_storage_record_count: 0,
    };
    assert_eq!(
        wkwebview_public_capability_blockers(cookie_only),
        vec![
            WKWEBVIEW_COOKIE_ATTRIBUTES_INCOMPLETE,
            WKWEBVIEW_SNAPSHOT_STABILITY_UNPROVABLE,
        ]
    );
    assert_eq!(
        wkwebview_primary_capability_blocker(cookie_only),
        WKWEBVIEW_COOKIE_ATTRIBUTES_INCOMPLETE
    );

    let local_storage_only = MacosWkRoleSessionPublicObservation {
        cookie_count: 0,
        http_only_cookie_count: 0,
        local_storage_record_count: 3,
    };
    assert_eq!(
        wkwebview_public_capability_blockers(local_storage_only),
        vec![
            WKWEBVIEW_LOCAL_STORAGE_VALUES_UNREADABLE,
            WKWEBVIEW_SNAPSHOT_STABILITY_UNPROVABLE,
        ]
    );
    assert_eq!(
        wkwebview_primary_capability_blocker(local_storage_only),
        WKWEBVIEW_LOCAL_STORAGE_VALUES_UNREADABLE
    );

    let mixed = MacosWkRoleSessionPublicObservation {
        cookie_count: 4,
        http_only_cookie_count: 2,
        local_storage_record_count: 2,
    };
    assert_eq!(
        wkwebview_public_capability_blockers(mixed),
        vec![
            WKWEBVIEW_COOKIE_ATTRIBUTES_INCOMPLETE,
            WKWEBVIEW_LOCAL_STORAGE_VALUES_UNREADABLE,
            WKWEBVIEW_SNAPSHOT_STABILITY_UNPROVABLE,
        ]
    );
    assert_eq!(
        wkwebview_primary_capability_blocker(mixed),
        WKWEBVIEW_LOCAL_STORAGE_VALUES_UNREADABLE
    );

    let empty = MacosWkRoleSessionPublicObservation {
        cookie_count: 0,
        http_only_cookie_count: 0,
        local_storage_record_count: 0,
    };
    assert_eq!(
        wkwebview_public_capability_blockers(empty),
        vec![WKWEBVIEW_SNAPSHOT_STABILITY_UNPROVABLE]
    );
}

#[test]
fn wkwebview_export_plan_is_revision_fenced_and_keeps_authenticated_vault_resume() {
    let mut journal = wkwebview_test_journal();
    let request = wkwebview_test_request();
    let evidence = wkwebview_test_evidence();
    assert_eq!(
        plan_wkwebview_source_export(&journal, &request, None).unwrap(),
        WkwebviewSourceExportPlan::ObservePublicCapabilities
    );
    assert_eq!(
        plan_wkwebview_source_export(&journal, &request, Some(&evidence)).unwrap(),
        WkwebviewSourceExportPlan::ResumePublishedVault
    );

    journal.phase = rion_core::RoleSessionMigrationPhase::Exported;
    journal.journal_revision = 8;
    journal.envelope_sha256 = Some("a".repeat(64));
    journal.inventory_sha256 = Some("b".repeat(64));
    journal.cookie_count = Some(1);
    journal.local_storage_origin_count = Some(2);
    journal.local_storage_entry_count = Some(3);
    assert_eq!(
        plan_wkwebview_source_export(&journal, &request, None).unwrap(),
        WkwebviewSourceExportPlan::VerifyExported
    );

    journal.phase = rion_core::RoleSessionMigrationPhase::Failed;
    journal.envelope_sha256 = None;
    journal.inventory_sha256 = None;
    journal.cookie_count = None;
    journal.local_storage_origin_count = None;
    journal.local_storage_entry_count = None;
    journal.stable_error_code = Some(WKWEBVIEW_COOKIE_ATTRIBUTES_INCOMPLETE.to_owned());
    journal.outcome = Some(rion_core::RoleSessionMigrationOutcome::Failed);
    journal.outcome_at = Some(request.occurred_at.clone());
    assert_eq!(
        plan_wkwebview_source_export(&journal, &request, None).unwrap(),
        WkwebviewSourceExportPlan::ReplayKnownFailure
    );

    let mut stale = request.clone();
    stale.expected_journal_revision += 2;
    assert_eq!(
        plan_wkwebview_source_export(&journal, &stale, None)
            .unwrap_err()
            .code,
        "ROLE_SESSION_TRANSFER_WKWEBVIEW_JOURNAL_STALE"
    );
    journal.platform = rion_core::RoleSessionMigrationPlatform::Windows;
    journal.source_engine = rion_core::RoleSessionMigrationEngine::Webview2;
    assert_eq!(
        plan_wkwebview_source_export(&journal, &request, None)
            .unwrap_err()
            .code,
        "ROLE_SESSION_TRANSFER_WKWEBVIEW_JOURNAL_STALE"
    );
}

#[test]
fn wkwebview_export_and_failure_transitions_never_mix_inventory_evidence() {
    let request = wkwebview_test_request();
    let exported = wkwebview_export_transition(&request, &wkwebview_test_evidence()).unwrap();
    assert_eq!(exported.next_phase, rion_core::RoleSessionMigrationPhase::Exported);
    assert_eq!(exported.envelope_sha256, Some("a".repeat(64)));
    assert_eq!(exported.local_storage_entry_count, Some(3));
    assert!(exported.stable_error_code.is_none());

    let failed = wkwebview_failed_transition(
        &request,
        WKWEBVIEW_LOCAL_STORAGE_VALUES_UNREADABLE,
    );
    assert_eq!(failed.next_phase, rion_core::RoleSessionMigrationPhase::Failed);
    assert_eq!(
        failed.outcome,
        Some(rion_core::RoleSessionMigrationOutcome::Failed)
    );
    assert_eq!(
        failed.stable_error_code.as_deref(),
        Some(WKWEBVIEW_LOCAL_STORAGE_VALUES_UNREADABLE)
    );
    assert!(failed.envelope_sha256.is_none());
    assert!(failed.inventory_sha256.is_none());
    assert!(failed.cookie_count.is_none());
    assert!(failed.local_storage_origin_count.is_none());
    assert!(failed.local_storage_entry_count.is_none());
}

#[test]
fn wkwebview_source_probe_uses_only_public_event_callbacks_and_no_data_guessing() {
    let native = include_str!("../../../native/macos/RionWKWebViewInput/03_role_session_export.m");
    let rust = include_str!("../platform/macos/session_export.rs");
    let coordinator = include_str!("../section_29_macos_role_session_export.rs");
    let aggregate = include_str!("../../../native/macos/RionWKWebViewInput.m");
    let build = include_str!("../../../build.rs");
    let startup = include_str!("../../lib/section_09_run.rs");

    for required in [
        "dataStoreForIdentifier",
        "getAllCookies",
        "cookie.HTTPOnly",
        "cookie.sameSitePolicy",
        "fetchDataRecordsOfTypes",
        "WKWebsiteDataTypeLocalStorage",
        "record.dataTypes",
        "[NSThread isMainThread]",
        "dispatch_get_main_queue",
    ] {
        assert!(native.contains(required), "missing public evidence API {required}");
    }
    assert!(aggregate.contains("03_role_session_export.m"));
    assert!(build.contains("03_role_session_export.m"));
    assert!(rust.contains("oneshot::channel"));
    assert!(rust.contains("receiver.await"));
    assert!(coordinator.contains("pending_role_session_transfer_vault_evidence_internal"));
    assert!(coordinator.contains("verified_role_session_transfer_vault_evidence_internal"));
    assert!(coordinator.contains("role_session_migrations()"));
    assert!(coordinator.contains("RoleSessionMigrationPhase::V22Ready"));
    assert!(coordinator.contains("RoleSessionMigrationPhase::Exported"));
    assert!(startup.contains("prepare_v22_role_session_migrations_internal"));
    assert!(startup.contains("schedule_macos_v22_role_session_export_resume"));
    assert!(!coordinator.contains("write_role_session_transfer_vault_internal"));
    assert!(!coordinator.contains("start_role_session_migration"));

    for forbidden in [
        "performSelector",
        "objc_msgSend",
        "_websiteDataStore",
        "evaluateJavaScript",
        "fetchDataOfTypes",
        "contentsOfDirectory",
        "directoryEnumerator",
        "thread::sleep",
        "tokio::time",
        "recv_timeout",
        "BrowserWindow",
        "remote-debugging",
    ] {
        assert!(
            !native.contains(forbidden)
                && !rust.contains(forbidden)
                && !coordinator.contains(forbidden),
            "forbidden WKWebView export mechanism returned: {forbidden}"
        );
    }
}
