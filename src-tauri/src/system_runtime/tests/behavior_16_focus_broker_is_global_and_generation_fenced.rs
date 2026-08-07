#[test]
fn focus_broker_latest_intent_wins_across_runtime_windows() {
    let broker = NativeFocusBroker::default();
    let first = broker.accept(
        "window-a",
        4,
        2,
        Some("tab-a".to_owned()),
        NativePresentationFocus::WindowAndContent,
    );
    assert!(broker.begin_mutation(&first).unwrap().is_some());

    let second = broker.accept(
        "window-b",
        7,
        2,
        Some("tab-b".to_owned()),
        NativePresentationFocus::ContentOnly,
    );
    assert!(broker.begin_mutation(&first).unwrap().is_none());
    assert!(broker.begin_mutation(&second).unwrap().is_some());
    assert!(broker.confirm(&second));

    let (current, confirmed) = broker.snapshot();
    assert_eq!(current, Some(second.clone()));
    assert_eq!(confirmed, Some(second));
}

#[test]
fn native_focus_observation_confirms_matching_intent_and_supersedes_other_windows() {
    let broker = NativeFocusBroker::default();
    let requested = broker.accept(
        "window-a",
        3,
        9,
        Some("tab-a".to_owned()),
        NativePresentationFocus::WindowAndContent,
    );
    assert!(broker.mark_submitted(&requested));
    let matching = broker.observe_native_focus(
        "window-a",
        3,
        9,
        Some("tab-a".to_owned()),
    );
    assert_eq!(matching, Some(requested.clone()));

    let external = broker.observe_native_focus(
        "window-b",
        8,
        9,
        Some("tab-b".to_owned()),
    ).expect("an external native focus event creates a confirmed lease");
    assert_ne!(external.sequence, requested.sequence);
    assert!(!broker.is_current(&requested));
    assert!(broker.is_current(&external));
}

#[test]
fn focus_revocation_is_scoped_to_the_exact_window_generation() {
    let broker = NativeFocusBroker::default();
    let replacement = broker.accept(
        "window-a",
        12,
        5,
        None,
        NativePresentationFocus::WindowAndContent,
    );
    assert!(broker.confirm(&replacement));

    broker.revoke_window("window-a", 11);
    assert!(broker.is_current(&replacement));

    broker.observe_native_blur("window-a", 11);
    assert_eq!(broker.snapshot().1, Some(replacement.clone()));

    broker.revoke_window("window-a", 12);
    assert_eq!(broker.snapshot(), (None, None));
    assert!(!broker.is_current(&replacement));
}

#[test]
fn delayed_reveal_focus_resolves_only_the_exact_current_sequence_and_generation() {
    let broker = NativeFocusBroker::default();
    let requested = broker.accept(
        "window-a",
        12,
        5,
        Some("tab-a".to_owned()),
        NativePresentationFocus::WindowAndContent,
    );
    assert_eq!(
        broker.current_lease_for(requested.sequence, "window-a", 12),
        Some(requested.clone())
    );
    assert_eq!(
        broker.current_lease_for(requested.sequence, "window-a", 11),
        None
    );

    let replacement = broker.accept(
        "window-b",
        7,
        5,
        Some("tab-b".to_owned()),
        NativePresentationFocus::WindowAndContent,
    );
    assert_eq!(
        broker.current_lease_for(requested.sequence, "window-a", 12),
        None
    );
    assert_eq!(
        broker.current_lease_for(replacement.sequence, "window-b", 7),
        Some(replacement)
    );
}
