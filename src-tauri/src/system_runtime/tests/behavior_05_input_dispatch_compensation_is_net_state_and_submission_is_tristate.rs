fn key_effect(
    phase: &str,
    code: &str,
    active_codes_before: &[&str],
    active_codes: &[&str],
) -> EmbeddedKeyEffectRecord {
    EmbeddedKeyEffectRecord {
        phase: phase.to_owned(),
        code: code.to_owned(),
        active_codes_before: active_codes_before
            .iter()
            .map(|code| (*code).to_owned())
            .collect(),
        active_codes: active_codes
            .iter()
            .map(|code| (*code).to_owned())
            .collect(),
        auto_repeat: false,
        suppress_shortcut: false,
    }
}

#[test]
fn completed_tap_has_no_compensation_and_cannot_be_replayed() {
    let effects = vec![
        key_effect("rawKeyDown", "KeyA", &[], &["KeyA"]),
        key_effect("keyUp", "KeyA", &["KeyA"], &[]),
    ];

    assert!(key_prefix_compensation(&effects).is_empty());
}

#[test]
fn confirmed_partial_prefix_restores_only_the_initial_net_key_state() {
    let effects = vec![
        key_effect("rawKeyDown", "ControlLeft", &[], &["ControlLeft"]),
        key_effect(
            "rawKeyDown",
            "KeyA",
            &["ControlLeft"],
            &["ControlLeft", "KeyA"],
        ),
    ];
    let compensation = key_prefix_compensation(&effects);

    assert_eq!(
        compensation
            .iter()
            .map(|effect| (effect.phase.as_str(), effect.code.as_str()))
            .collect::<Vec<_>>(),
        [("keyUp", "KeyA"), ("keyUp", "ControlLeft")]
    );
}

#[test]
fn partial_reassert_releases_every_confirmed_press_in_safe_order() {
    let effects = vec![
        key_effect("rawKeyDown", "ControlLeft", &[], &["ControlLeft"]),
        key_effect(
            "rawKeyDown",
            "KeyA",
            &["ControlLeft"],
            &["ControlLeft", "KeyA"],
        ),
    ];

    assert_eq!(
        release_reasserted_key_effects(&effects)
            .iter()
            .map(|effect| effect.code.as_str())
            .collect::<Vec<_>>(),
        ["KeyA", "ControlLeft"]
    );
}

#[test]
fn expired_or_replaced_ui_callback_is_rejected_before_submission() {
    let lane = Arc::new(RoleInputDispatchLane::default());
    lane.epoch.store(7, Ordering::Release);
    lane.surface_generation.store(3, Ordering::Release);
    let context = InputDispatchContext {
        deadline: Instant::now(),
        input_epoch: 7,
        intent: "normal".to_owned(),
        lane: Arc::clone(&lane),
        surface_generation: 3,
    };
    let expired = NativeInputSubmissionGuard::new(&context);
    assert!(!expired.claim());
    assert_eq!(expired.timeout_error().code, "BROWSER_ACTION_DEADLINE");

    let cleanup = InputDispatchContext {
        intent: "cleanup".to_owned(),
        ..context
    };
    let stale = NativeInputSubmissionGuard::new(&cleanup);
    lane.epoch.store(8, Ordering::Release);
    assert!(!stale.claim());
    assert_eq!(stale.timeout_error().code, "BROWSER_ACTION_DEADLINE");
}

#[test]
fn submitted_callback_without_completion_is_indeterminate() {
    let lane = Arc::new(RoleInputDispatchLane::default());
    lane.epoch.store(1, Ordering::Release);
    lane.surface_generation.store(1, Ordering::Release);
    let context = InputDispatchContext {
        deadline: Instant::now() + Duration::from_secs(60),
        input_epoch: 1,
        intent: "normal".to_owned(),
        lane,
        surface_generation: 1,
    };
    let submission = NativeInputSubmissionGuard::new(&context);

    assert!(submission.claim());
    assert_eq!(
        submission.timeout_error().code,
        "SYSTEM_TRUSTED_INPUT_INDETERMINATE"
    );
}

fn live_input_context() -> InputDispatchContext {
    let lane = Arc::new(RoleInputDispatchLane::default());
    lane.epoch.store(1, Ordering::Release);
    lane.surface_generation.store(1, Ordering::Release);
    InputDispatchContext {
        deadline: Instant::now() + Duration::from_secs(60),
        input_epoch: 1,
        intent: "normal".to_owned(),
        lane,
        surface_generation: 1,
    }
}

#[test]
fn indeterminate_mouse_down_schedules_exactly_one_cleanup_mouse_up() {
    let context = live_input_context();
    let cleanup = InputDispatchContext {
        intent: "cleanup".to_owned(),
        ..context.clone()
    };
    let mut phases = Vec::new();
    let result = dispatch_mouse_input_sequence(&context, || cleanup.clone(), |pressed, _| {
        phases.push(pressed);
        if pressed {
            Err(RuntimeError::new(
                "SYSTEM_TRUSTED_INPUT_INDETERMINATE",
                "completion lost",
            ))
        } else {
            Ok(())
        }
    });

    assert!(result.is_err());
    assert_eq!(phases, [true, false]);
}

#[test]
fn rejected_mouse_down_does_not_emit_a_spurious_mouse_up() {
    let context = live_input_context();
    let cleanup = InputDispatchContext {
        intent: "cleanup".to_owned(),
        ..context.clone()
    };
    let mut phases = Vec::new();
    let result = dispatch_mouse_input_sequence(&context, || cleanup.clone(), |pressed, _| {
        phases.push(pressed);
        Err(RuntimeError::new(
            "BROWSER_ACTION_DEADLINE",
            "rejected before submit",
        ))
    });

    assert!(result.is_err());
    assert_eq!(phases, [true]);
}

#[test]
fn mouse_up_adopts_a_fence_that_arrives_after_confirmed_mouse_down() {
    let context = live_input_context();
    let lane = Arc::clone(&context.lane);
    let cleanup_lane = Arc::clone(&lane);
    let mut observed_cleanup_epoch = None;
    let result = dispatch_mouse_input_sequence(
        &context,
        || InputDispatchContext {
            deadline: Instant::now() + Duration::from_secs(60),
            input_epoch: cleanup_lane.epoch.load(Ordering::Acquire),
            intent: "cleanup".to_owned(),
            lane: Arc::clone(&cleanup_lane),
            surface_generation: 1,
        },
        |pressed, context| {
            if pressed {
                lane.epoch.store(2, Ordering::Release);
            } else {
                observed_cleanup_epoch = Some(context.input_epoch);
            }
            Ok(())
        },
    );

    assert!(result.is_ok());
    assert_eq!(observed_cleanup_epoch, Some(2));
}
