fn dormant_window(id: &str) -> RuntimeRestoreWindowRecord {
    RuntimeRestoreWindowRecord {
        id: id.to_owned(),
        target_display: DisplayTargetRecord {
            id: 1,
            fingerprint: None,
        },
        was_visible: true,
        active_source_id: None,
        tabs: Vec::new(),
    }
}

#[test]
fn dormant_window_restore_states_cover_wait_start_success_failure_retry_and_discard() {
    let first = dormant_window("first");
    let second = dormant_window("second");
    let third = dormant_window("third");
    let mut state = RuntimeState::default();

    initialize_dormant_window_state(
        &mut state,
        vec![first.clone(), second.clone(), third.clone()],
        HashSet::from(["first".to_owned(), "second".to_owned(), "third".to_owned()]),
    );
    assert_eq!(
        state.dormant_window_states.get("first"),
        Some(&DormantWindowState::AwaitingRecovery)
    );
    assert_eq!(state.session_recovery_window_ids.len(), 3);

    let attempted = begin_dormant_window_restore_state(
        &mut state,
        &["first".to_owned(), "second".to_owned()],
    );
    assert_eq!(attempted, ["first", "second"]);
    assert_eq!(
        state.dormant_window_states.get("first"),
        Some(&DormantWindowState::Restoring)
    );
    assert_eq!(
        state.dormant_window_states.get("third"),
        Some(&DormantWindowState::AwaitingRecovery)
    );

    finish_dormant_window_restore_state(
        &mut state,
        &attempted,
        &["first".to_owned()],
        &HashMap::from([("second".to_owned(), "Display unavailable.".to_owned())]),
    );
    assert!(!state.dormant_window_states.contains_key("first"));
    assert!(!state.session_recovery_window_ids.contains("first"));
    assert_eq!(
        state.dormant_window_states.get("second"),
        Some(&DormantWindowState::Failed {
            failure_message: "Display unavailable.".to_owned()
        })
    );
    assert_eq!(
        state.dormant_window_states.get("third"),
        Some(&DormantWindowState::AwaitingRecovery)
    );

    let retry = begin_dormant_window_restore_state(&mut state, &["second".to_owned()]);
    assert_eq!(retry, ["second"]);
    assert!(fail_dormant_window_restore_state(
        &mut state,
        &retry,
        "Restore stream stopped."
    ));
    assert_eq!(
        state
            .dormant_window_states
            .get("second")
            .and_then(DormantWindowState::failure_message),
        Some("Restore stream stopped.")
    );

    let requested = HashSet::from(["second".to_owned()]);
    assert_eq!(
        discard_dormant_window_recovery_state(&mut state, Some(&requested)),
        ["second"]
    );
    assert_eq!(
        state.dormant_window_states.get("second"),
        Some(&DormantWindowState::Dormant)
    );
    assert_eq!(state.session_recovery_window_ids, HashSet::from(["third".to_owned()]));

    assert_eq!(
        discard_dormant_window_recovery_state(&mut state, None),
        ["third"]
    );
    assert!(state.session_recovery_window_ids.is_empty());
    assert!(state
        .dormant_window_states
        .values()
        .all(|status| status == &DormantWindowState::Dormant));
}

#[test]
fn restoring_one_window_never_reclassifies_other_dormant_windows() {
    let first = dormant_window("first");
    let second = dormant_window("second");
    let mut state = RuntimeState::default();
    initialize_dormant_window_state(&mut state, vec![first, second], HashSet::new());
    state.runtime_restart_required = true;

    let attempted = begin_dormant_window_restore_state(&mut state, &["first".to_owned()]);
    assert_eq!(
        begin_dormant_window_restore_state(&mut state, &["first".to_owned()]),
        Vec::<String>::new(),
        "an in-flight restore cannot start twice"
    );
    finish_dormant_window_restore_state(
        &mut state,
        &attempted,
        &["first".to_owned()],
        &HashMap::new(),
    );

    assert_eq!(
        state.dormant_window_states.get("second"),
        Some(&DormantWindowState::Dormant)
    );
    assert!(state.session_recovery_window_ids.is_empty());
    assert!(state.runtime_restart_required);
}

#[test]
fn every_unfinished_restoring_window_terminalizes_as_failed() {
    let window = dormant_window("window");
    let mut state = RuntimeState::default();
    initialize_dormant_window_state(&mut state, vec![window], HashSet::new());
    let attempted = begin_dormant_window_restore_state(&mut state, &["window".to_owned()]);

    finish_dormant_window_restore_state(
        &mut state,
        &attempted,
        &[],
        &HashMap::new(),
    );

    assert!(matches!(
        state.dormant_window_states.get("window"),
        Some(DormantWindowState::Failed { .. })
    ));
    assert!(state
        .dormant_window_states
        .values()
        .all(|status| status != &DormantWindowState::Restoring));
}

#[test]
fn session_recovery_only_marks_windows_that_were_live_at_the_crash() {
    let mut state = RuntimeState::default();
    initialize_dormant_window_state(
        &mut state,
        vec![dormant_window("closed-b"), dormant_window("live-a")],
        HashSet::from(["live-a".to_owned(), "deleted-window".to_owned()]),
    );

    assert_eq!(
        state.dormant_window_states.get("closed-b"),
        Some(&DormantWindowState::Dormant)
    );
    assert_eq!(
        state.dormant_window_states.get("live-a"),
        Some(&DormantWindowState::AwaitingRecovery)
    );
    assert_eq!(
        state.session_recovery_window_ids,
        HashSet::from(["live-a".to_owned()])
    );
}

#[test]
fn startup_recovery_cohort_uses_live_and_interrupted_windows_only() {
    let dormant = HashSet::from([
        "closed-b".to_owned(),
        "live-a".to_owned(),
        "restoring-c".to_owned(),
    ]);
    assert_eq!(
        session_recovery_window_ids_for_startup(
            false,
            Some(&["live-a".to_owned(), "deleted".to_owned()]),
            &["restoring-c".to_owned()],
            &dormant,
        ),
        HashSet::from(["live-a".to_owned(), "restoring-c".to_owned()])
    );
    assert!(session_recovery_window_ids_for_startup(
        true,
        Some(&["live-a".to_owned()]),
        &["restoring-c".to_owned()],
        &dormant,
    )
    .is_empty());
    assert_eq!(
        session_recovery_window_ids_for_startup(false, None, &[], &dormant),
        dormant,
        "legacy journals without a live cohort preserve the old recovery behavior"
    );
}

#[test]
fn dormant_window_state_wire_names_are_explicit() {
    for (state, expected) in [
        (DormantWindowState::Dormant, "dormant"),
        (
            DormantWindowState::AwaitingRecovery,
            "awaiting-recovery",
        ),
        (DormantWindowState::Restoring, "restoring"),
        (
            DormantWindowState::Failed {
                failure_message: "failed".to_owned(),
            },
            "failed",
        ),
    ] {
        assert_eq!(state.as_str(), expected);
    }
}
