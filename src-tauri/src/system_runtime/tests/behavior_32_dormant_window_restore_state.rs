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

    replace_dormant_window_state(
        &mut state,
        vec![first.clone(), second.clone(), third.clone()],
        true,
    );
    assert!(state.recovery_required);
    assert_eq!(
        state.dormant_window_states.get("first"),
        Some(&DormantWindowState::AwaitingRecovery)
    );

    assert!(begin_dormant_window_restore_state(
        &mut state,
        &["first".to_owned(), "second".to_owned()]
    ));
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
        vec![second.clone(), third.clone()],
        true,
        &HashMap::from([("second".to_owned(), "Display unavailable.".to_owned())]),
    );
    assert!(!state.dormant_window_states.contains_key("first"));
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

    assert!(begin_dormant_window_restore_state(
        &mut state,
        &["second".to_owned()]
    ));
    assert!(fail_dormant_window_restore_state(
        &mut state,
        &["second".to_owned()],
        "Restore stream stopped."
    ));
    assert_eq!(
        state
            .dormant_window_states
            .get("second")
            .and_then(DormantWindowState::failure_message),
        Some("Restore stream stopped.")
    );

    replace_dormant_window_state(&mut state, vec![second, third], false);
    assert!(!state.recovery_required);
    assert!(state
        .dormant_window_states
        .values()
        .all(|status| status == &DormantWindowState::Dormant));

    replace_dormant_window_state(&mut state, Vec::new(), true);
    assert!(!state.recovery_required);
    assert!(state.dormant_window_states.is_empty());
}

#[test]
fn every_unfinished_restoring_window_terminalizes_as_failed() {
    let window = dormant_window("window");
    let mut state = RuntimeState::default();
    replace_dormant_window_state(&mut state, vec![window.clone()], false);
    assert!(begin_dormant_window_restore_state(
        &mut state,
        std::slice::from_ref(&window.id)
    ));

    finish_dormant_window_restore_state(&mut state, vec![window], false, &HashMap::new());

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
