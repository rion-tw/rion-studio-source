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


