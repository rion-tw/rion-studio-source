#[test]
fn failed_launch_cleanup_generations_keep_native_destroy_idempotent() {
    let mut state = RuntimeState::default();
    state
        .completed_failed_launch_cleanups
        .insert(("tab-failed".to_owned(), "attempt-1".to_owned()));
    state
        .launch_attempt_generations
        .insert("tab-failed".to_owned(), "attempt-2".to_owned());
    assert!(failed_launch_cleanup_has_completed(
        &state,
        "tab-failed",
        Some("attempt-1")
    ));
    assert!(failed_launch_cleanup_has_completed(
        &state,
        "tab-failed",
        Some("attempt-1")
    ));
    assert!(!failed_launch_cleanup_has_completed(
        &state,
        "tab-failed",
        Some("attempt-2")
    ));
    assert!(!launch_attempt_is_current(
        &state,
        "tab-failed",
        Some("attempt-1")
    ));
    assert!(launch_attempt_is_current(
        &state,
        "tab-failed",
        Some("attempt-2")
    ));
}

#[test]
fn dependent_launches_tolerate_missing_or_invalid_sync_snapshots() {
    for code in [
        "LOCAL_STORAGE_SYNC_CACHE_UNAVAILABLE",
        "LOCAL_STORAGE_SYNC_CACHE_INVALID",
        "LOCAL_STORAGE_SYNC_CACHE_TOO_LARGE",
        "LOCAL_STORAGE_SYNC_SNAPSHOT_INVALID",
        "LOCAL_STORAGE_SYNC_FLYFF_SETTINGS_INVALID",
        "LOCAL_STORAGE_SYNC_FLYFF_CHINA_SETTINGS_INVALID",
        "SYSTEM_ROLE_SETUP_FAILED",
        "SYSTEM_ROLE_SETUP_TIMEOUT",
        "SYSTEM_WEBVIEW_CREATION_STALLED",
        "TAURI_RUNTIME_FAILED",
    ] {
        assert!(local_storage_sync_launch_can_continue_without_snapshot(
            &RuntimeError::new(code, "recoverable snapshot failure")
        ));
    }
    assert!(!local_storage_sync_launch_can_continue_without_snapshot(
        &RuntimeError::new("SYSTEM_SURFACE_RELEASE_UNVERIFIED", "unsafe cleanup failure")
    ));
}

#[test]
fn snapshot_codec_errors_keep_specific_codes_and_reject_unknown_variants() {
    let flyff = reject_local_storage_sync_snapshot_codec_error(
        &json!({ "error": "FLYFF_SETTINGS_INVALID" }),
        Some(rion_core::FLYFF_LOCAL_STORAGE_SYNC_CODEC),
    )
    .unwrap_err();
    assert_eq!(flyff.code, "LOCAL_STORAGE_SYNC_FLYFF_SETTINGS_INVALID");
    assert!(flyff.message.contains("Open the role"));

    let flyff_china = reject_local_storage_sync_snapshot_codec_error(
        &json!({ "error": "FLYFF_CHINA_SETTINGS_INVALID" }),
        Some(rion_core::FLYFF_CHINA_LOCAL_STORAGE_SYNC_CODEC),
    )
    .unwrap_err();
    assert_eq!(
        flyff_china.code,
        "LOCAL_STORAGE_SYNC_FLYFF_CHINA_SETTINGS_INVALID"
    );

    for (value, codec) in [
        (
            json!({ "error": "UNKNOWN" }),
            Some(rion_core::FLYFF_LOCAL_STORAGE_SYNC_CODEC),
        ),
        (
            json!({ "error": "FLYFF_SETTINGS_INVALID" }),
            Some(rion_core::FLYFF_CHINA_LOCAL_STORAGE_SYNC_CODEC),
        ),
        (json!({ "error": 7 }), None),
    ] {
        assert_eq!(
            reject_local_storage_sync_snapshot_codec_error(&value, codec)
                .unwrap_err()
                .code,
            "LOCAL_STORAGE_SYNC_SNAPSHOT_INVALID"
        );
    }
    assert!(
        reject_local_storage_sync_snapshot_codec_error(&json!({ "values": [] }), None).is_ok()
    );
}
