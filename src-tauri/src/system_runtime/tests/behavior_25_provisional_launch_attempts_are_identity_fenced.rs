fn provisional_launch(
    launch_preview_id: &str,
    tab_id: &str,
    source_id: &str,
    tab_type: &str,
    failed: bool,
) -> ProvisionalLaunch {
    ProvisionalLaunch {
        cancelled: false,
        failed,
        host_created: false,
        id: tab_id.to_owned(),
        launch_preview_id: launch_preview_id.to_owned(),
        source_id: source_id.to_owned(),
        tab_type: tab_type.to_owned(),
        window_id: "window-1".to_owned(),
    }
}

#[test]
fn cancelled_attempt_and_same_source_relaunch_are_independently_fenced() {
    for (platform, tab_type) in [
        ("macos", "role"),
        ("macos", "workspace"),
        ("windows", "role"),
        ("windows", "workspace"),
    ] {
        let mut state = RuntimeState::default();
        insert_provisional_launch(
            &mut state,
            provisional_launch("preview-a", "tab-a", "source-1", tab_type, false),
        );
        let cancelled = cancel_provisional_launch_state(&mut state, "tab-a").unwrap();
        assert_eq!(cancelled.launch_preview_id, "preview-a", "{platform}");
        assert!(active_provisional_launch(&state, "source-1", tab_type).is_none());

        insert_provisional_launch(
            &mut state,
            provisional_launch("preview-b", "tab-b", "source-1", tab_type, false),
        );
        assert_eq!(
            active_provisional_launch(&state, "source-1", tab_type)
                .unwrap()
                .launch_preview_id,
            "preview-b",
            "{platform}"
        );

        let old = take_provisional_launch_attempt(
            &mut state,
            "preview-a",
            "window-1",
            "source-1",
            tab_type,
        )
        .unwrap_err();
        assert_eq!(old.code, "LAUNCH_CANCELLED", "{platform}");
        assert_eq!(
            active_provisional_launch(&state, "source-1", tab_type)
                .unwrap()
                .launch_preview_id,
            "preview-b",
            "{platform}"
        );

        let current = take_provisional_launch_attempt(
            &mut state,
            "preview-b",
            "window-1",
            "source-1",
            tab_type,
        )
        .unwrap();
        assert_eq!(current.id, "tab-b", "{platform}");
        assert!(active_provisional_launch(&state, "source-1", tab_type).is_none());
    }
}

#[test]
fn new_attempt_can_attach_before_the_cancelled_callback_arrives() {
    let mut state = RuntimeState::default();
    insert_provisional_launch(
        &mut state,
        provisional_launch("preview-a", "tab-a", "role-1", "role", false),
    );
    cancel_provisional_launch_state(&mut state, "tab-a").unwrap();
    insert_provisional_launch(
        &mut state,
        provisional_launch("preview-b", "tab-b", "role-1", "role", false),
    );

    let current = take_provisional_launch_attempt(
        &mut state,
        "preview-b",
        "window-1",
        "role-1",
        "role",
    )
    .unwrap();
    assert_eq!(current.id, "tab-b");
    let old = take_provisional_launch_attempt(
        &mut state,
        "preview-a",
        "window-1",
        "role-1",
        "role",
    )
    .unwrap_err();
    assert_eq!(old.code, "LAUNCH_CANCELLED");
}

#[test]
fn stale_or_mismatched_effect_cannot_consume_the_active_preview() {
    let mut state = RuntimeState::default();
    insert_provisional_launch(
        &mut state,
        provisional_launch("preview-b", "tab-b", "role-1", "role", false),
    );

    let unknown = take_provisional_launch_attempt(
        &mut state,
        "missing-preview",
        "window-1",
        "role-1",
        "role",
    )
    .unwrap_err();
    assert_eq!(unknown.code, "LAUNCH_PREVIEW_STALE");
    let mismatch = take_provisional_launch_attempt(
        &mut state,
        "preview-b",
        "window-1",
        "other-role",
        "role",
    )
    .unwrap_err();
    assert_eq!(mismatch.code, "LAUNCH_PREVIEW_STALE");
    assert_eq!(
        active_provisional_launch(&state, "role-1", "role")
            .unwrap()
            .id,
        "tab-b"
    );
}

#[test]
fn retry_reuses_the_presentation_but_rotates_the_attempt_identity() {
    let mut state = RuntimeState::default();
    insert_provisional_launch(
        &mut state,
        provisional_launch("preview-a", "failed-tab", "role-1", "role", true),
    );

    let retry = renew_failed_provisional_launch(&mut state, "preview-a").unwrap();
    assert_ne!(retry.launch_preview_id, "preview-a");
    assert_eq!(retry.provisional_tab_id, "failed-tab");
    assert!(!state.provisional_launches.contains_key("preview-a"));
    assert_eq!(
        active_provisional_launch(&state, "role-1", "role")
            .unwrap()
            .launch_preview_id,
        retry.launch_preview_id
    );
}

#[test]
fn automatic_retry_marker_moves_to_the_rotated_identity_and_remains_cancellable() {
    let mut state = RuntimeState::default();
    insert_provisional_launch(
        &mut state,
        provisional_launch("preview-a", "retry-tab", "role-1", "role", false),
    );
    state
        .automatic_launch_retries
        .insert("preview-a".to_owned(), 1);
    assert!(automatic_launch_retry_is_current(&state, "preview-a"));

    let retry = renew_provisional_launch(&mut state, "preview-a", false).unwrap();
    assert!(!state.automatic_launch_retries.contains_key("preview-a"));
    state
        .automatic_launch_retries
        .insert(retry.launch_preview_id.clone(), 1);
    assert!(automatic_launch_retry_is_current(
        &state,
        &retry.launch_preview_id
    ));

    cancel_provisional_launch_state(&mut state, "retry-tab").unwrap();
    assert!(!automatic_launch_retry_is_current(
        &state,
        &retry.launch_preview_id
    ));
}

#[test]
fn cancelling_one_source_does_not_mutate_an_independent_preview() {
    let mut state = RuntimeState::default();
    insert_provisional_launch(
        &mut state,
        provisional_launch("preview-a", "tab-a", "role-a", "role", false),
    );
    insert_provisional_launch(
        &mut state,
        provisional_launch("preview-b", "tab-b", "role-b", "role", false),
    );

    cancel_provisional_launch_state(&mut state, "tab-a").unwrap();
    assert_eq!(
        active_provisional_launch(&state, "role-b", "role")
            .unwrap()
            .launch_preview_id,
        "preview-b"
    );
    let independent = take_provisional_launch_attempt(
        &mut state,
        "preview-b",
        "window-1",
        "role-b",
        "role",
    )
    .unwrap();
    assert_eq!(independent.id, "tab-b");
}
