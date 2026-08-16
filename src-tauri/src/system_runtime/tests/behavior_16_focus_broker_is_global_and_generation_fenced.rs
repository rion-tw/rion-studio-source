#[test]
fn focus_broker_latest_intent_wins_across_runtime_windows() {
    let broker = NativeFocusBroker::default();
    broker.observe_application_foreground();
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
fn external_foreground_event_revokes_deferred_focus_by_epoch() {
    let broker = NativeFocusBroker::default();
    broker.observe_application_foreground();
    let requested = broker.accept(
        "window-a",
        12,
        5,
        Some("tab-a".to_owned()),
        NativePresentationFocus::WindowAndContent,
    );
    assert_eq!(requested.foreground_epoch, 0);
    assert!(broker.begin_mutation(&requested).unwrap().is_some());

    broker.observe_external_foreground();
    assert_eq!(broker.foreground_epoch(), 1);
    assert_eq!(broker.snapshot(), (None, None));
    assert!(broker.begin_mutation(&requested).unwrap().is_none());
    broker.observe_external_foreground();
    assert_eq!(broker.foreground_epoch(), 1);

    broker.observe_application_foreground();
    assert!(broker.begin_mutation(&requested).unwrap().is_none());
}

#[test]
fn last_native_focus_survives_external_foreground_but_not_exact_generation_retirement() {
    let broker = NativeFocusBroker::default();
    let observed = broker
        .observe_native_focus("window-a", 12, 5, Some("tab-a".to_owned()))
        .expect("native focus establishes launch destination history");
    broker.observe_external_foreground();
    assert_eq!(
        broker
            .state
            .lock()
            .unwrap()
            .last_observed
            .as_ref()
            .map(|lease| (&lease.window_id, lease.window_generation)),
        Some((&observed.window_id, 12))
    );

    broker.revoke_window("window-a", 11);
    assert!(broker.state.lock().unwrap().last_observed.is_some());
    broker.revoke_window("window-a", 12);
    assert!(broker.state.lock().unwrap().last_observed.is_none());
}

#[test]
fn background_content_focus_is_not_admitted_without_the_active_window() {
    let broker = NativeFocusBroker::default();
    assert_eq!(
        broker.admitted_focus(
            NativePresentationFocus::ContentOnly,
            "window-a",
            3,
            NativeFocusIntentOrigin::RuntimeContinuation,
        ),
        NativePresentationFocus::None
    );

    let observed = broker
        .observe_native_focus("window-a", 3, 2, Some("tab-a".to_owned()))
        .expect("native focus establishes the active runtime window");
    assert!(broker.is_confirmed(&observed));
    assert_eq!(
        broker.admitted_focus(
            NativePresentationFocus::ContentOnly,
            "window-a",
            3,
            NativeFocusIntentOrigin::RuntimeContinuation,
        ),
        NativePresentationFocus::ContentOnly
    );
    assert_eq!(
        broker.admitted_focus(
            NativePresentationFocus::ContentOnly,
            "window-b",
            3,
            NativeFocusIntentOrigin::RuntimeContinuation,
        ),
        NativePresentationFocus::None
    );
}

#[test]
fn lifecycle_readiness_never_creates_focus_and_external_foreground_blocks_user_focus() {
    let broker = NativeFocusBroker::default();
    broker.observe_application_foreground();
    assert_eq!(
        broker.admitted_focus(
            NativePresentationFocus::WindowAndContent,
            "window-a",
            3,
            NativeFocusIntentOrigin::RuntimeLifecycle,
        ),
        NativePresentationFocus::None
    );

    broker.observe_external_foreground();
    assert_eq!(
        broker.admitted_focus(
            NativePresentationFocus::WindowAndContent,
            "window-a",
            3,
            NativeFocusIntentOrigin::UserGesture,
        ),
        NativePresentationFocus::None
    );
    assert_eq!(
        broker.admitted_focus(
            NativePresentationFocus::WindowAndContent,
            "window-a",
            3,
            NativeFocusIntentOrigin::SystemActivation,
        ),
        NativePresentationFocus::WindowAndContent
    );
}

#[test]
fn runtime_window_mode_controls_do_not_create_or_replace_a_focus_lease() {
    let broker = NativeFocusBroker::default();
    broker.observe_application_foreground();
    let existing = broker.accept(
        "window-a",
        3,
        2,
        Some("tab-a".to_owned()),
        NativePresentationFocus::WindowAndContent,
    );
    let before = broker.snapshot();

    for trigger in ["toggle-fullscreen", "toggle-maximized-runtime-window"] {
        let origin = native_focus_intent_origin(trigger);
        assert_eq!(origin, NativeFocusIntentOrigin::RuntimeContinuation);
        assert_eq!(
            broker.admitted_focus(
                NativePresentationFocus::None,
                "window-b",
                7,
                origin,
            ),
            NativePresentationFocus::None,
            "{trigger}"
        );
        assert_eq!(broker.snapshot(), before, "{trigger}");
        assert!(broker.is_current(&existing));
    }
}

#[test]
fn desktop_e2e_main_focus_preserves_the_visible_user_gesture_intent() {
    assert_eq!(
        native_focus_intent_origin("desktop-e2e-main-focus"),
        NativeFocusIntentOrigin::UserGesture
    );
}

#[test]
fn native_focus_observation_confirms_matching_intent_and_supersedes_other_windows() {
    let broker = NativeFocusBroker::default();
    broker.observe_application_foreground();
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
fn native_focus_before_submission_supersedes_the_pending_matching_intent() {
    let broker = NativeFocusBroker::default();
    broker.observe_application_foreground();
    let pending = broker.accept(
        "window-a",
        3,
        9,
        Some("tab-a".to_owned()),
        NativePresentationFocus::WindowAndContent,
    );

    let observed = broker
        .observe_native_focus("window-a", 3, 9, Some("tab-a".to_owned()))
        .expect("the native event is authoritative before actor submission");

    assert_ne!(observed.sequence, pending.sequence);
    assert_eq!(observed.origin, NativeFocusIntentOrigin::NativeObservation);
    assert!(broker.is_confirmed(&observed));
    assert!(!broker.is_current(&pending));
    assert!(!broker.mark_submitted(&pending));
    assert_eq!(
        broker
            .state
            .lock()
            .unwrap()
            .last_observed
            .as_ref()
            .map(|lease| lease.window_id.as_str()),
        Some("window-a")
    );
}

#[test]
fn focus_revocation_is_scoped_to_the_exact_window_generation() {
    let broker = NativeFocusBroker::default();
    broker.observe_application_foreground();
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
fn failed_native_submission_revokes_only_the_exact_focus_lease() {
    let broker = NativeFocusBroker::default();
    broker.observe_application_foreground();
    let failed = broker.accept(
        "main",
        12,
        5,
        None,
        NativePresentationFocus::WindowAndContent,
    );
    assert!(broker.mark_submitted(&failed));
    let replacement = broker.accept(
        "main",
        12,
        5,
        None,
        NativePresentationFocus::WindowAndContent,
    );

    assert!(!broker.revoke_lease(&failed));
    assert!(broker.is_current(&replacement));
    assert!(broker.mark_submitted(&replacement));
    assert_eq!(
        broker.observe_native_focus("main", 12, 5, None),
        Some(replacement.clone())
    );
    assert!(broker.is_confirmed_target("main", 12, 5));

    assert!(broker.revoke_lease(&replacement));
    assert_eq!(broker.snapshot(), (None, None));
}

#[test]
fn confirmed_target_projection_is_exact_and_cleared_by_authoritative_blur() {
    let broker = NativeFocusBroker::default();
    let observed = broker
        .observe_native_focus("main", 17, 4, None)
        .expect("the native focus event establishes the projection");
    assert!(broker.is_confirmed(&observed));
    assert!(broker.is_confirmed_target("main", 17, 4));
    assert!(!broker.is_confirmed_target("main", 16, 4));
    assert!(!broker.is_confirmed_target("main", 17, 3));

    broker.observe_native_blur("main", 17);
    assert!(!broker.is_confirmed_target("main", 17, 4));
}

#[test]
fn delayed_reveal_focus_resolves_only_the_exact_current_sequence_and_generation() {
    let broker = NativeFocusBroker::default();
    broker.observe_application_foreground();
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

#[test]
fn user_focus_requires_foreground_and_background_system_activation_is_revoked_once() {
    let broker = NativeFocusBroker::default();
    let user = broker.accept_with_origin(
        "window-a",
        3,
        1,
        None,
        NativePresentationFocus::WindowAndContent,
        NativeFocusIntentOrigin::UserGesture,
    );
    assert!(!broker.is_current(&user));

    let system = broker.accept_with_origin(
        "window-b",
        4,
        1,
        None,
        NativePresentationFocus::WindowAndContent,
        NativeFocusIntentOrigin::SystemActivation,
    );
    assert!(broker.is_current(&system));
    broker.observe_external_foreground();
    assert_eq!(broker.foreground_epoch(), 1);
    assert_eq!(broker.snapshot(), (None, None));
    assert!(!broker.is_current(&system));

    broker.observe_external_foreground();
    assert_eq!(broker.foreground_epoch(), 1);
}
