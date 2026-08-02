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
