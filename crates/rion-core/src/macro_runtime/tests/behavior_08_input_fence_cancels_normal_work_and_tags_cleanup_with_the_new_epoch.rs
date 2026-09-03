#[test]
fn input_fence_cancels_normal_work_and_tags_cleanup_with_the_new_epoch() {
    let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
    let runtime = MacroRuntime::new(Arc::new(move |batch| {
        let _ = events.send(batch);
    }));
    let (_, focus) = start_and_ack_focus(
        &runtime,
        &receiver,
        request(vec![MacroStepDefinition::Key {
            id: "held".to_owned(),
            code: "KeyW".to_owned(),
            modifiers: None,
            action: Some("hold_until_stop".to_owned()),
            label: None,
            duration_ms: None,
        }]),
    );
    assert!(focus
        .iter()
        .all(|action| action.input_epoch == 0 && action.intent == "normal"));

    let held = next_browser_actions(&receiver);
    assert!(held
        .iter()
        .all(|action| action.input_epoch == 0 && action.intent == "normal"));
    runtime.dispatch_results(success_results(held)).unwrap();

    let input_epoch = runtime.fence_role_input("r1").unwrap();
    assert_eq!(input_epoch, 1);
    let cleanup = next_browser_actions(&receiver);
    assert!(cleanup.iter().all(|action| {
        action.input_epoch == input_epoch
            && action.intent == "cleanup"
            && matches!(
                action.action,
                BrowserAction::Key {
                    ref phase,
                    ref code,
                    ..
                } if phase == "release" && code.as_deref() == Some("KeyW")
            )
    }));

    let draining = {
        let runtime = runtime.clone();
        thread::spawn(move || runtime.drain_role_input("r1", input_epoch).unwrap())
    };
    runtime.dispatch_results(success_results(cleanup)).unwrap();
    assert!(draining.join().unwrap());

    let error = runtime.start(request(Vec::new())).unwrap_err();
    assert_eq!(error.code(), "MACRO_ROLE_INPUT_FENCED");
    assert!(runtime.resume_role_input("r1", input_epoch).unwrap());
    assert!(!runtime.resume_role_input("r1", input_epoch).unwrap());
    assert!(!runtime
        .shared
        .inner
        .lock()
        .unwrap()
        .quiesced_role_ids
        .contains("r1"));
}

#[test]
fn stopping_role_cannot_report_a_successful_input_resume() {
    let runtime = MacroRuntime::new(Arc::new(|_| {}));
    runtime.request_stop_role("r1").unwrap();
    let diagnostic = runtime.input_diagnostics().unwrap();
    let role = diagnostic.roles.first().unwrap();

    assert!(role.stopping);
    assert!(role.quiesced);
    assert!(!runtime.resume_role_input("r1", role.input_epoch).unwrap());
    assert!(runtime
        .shared
        .inner
        .lock()
        .unwrap()
        .quiesced_role_ids
        .contains("r1"));
}

#[test]
fn navigation_failure_terminalizes_a_transferred_multi_role_run_after_a_recovery_fence() {
    let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
    let runtime = MacroRuntime::new(Arc::new(move |batch| {
        let _ = events.send(batch);
    }));
    let control = new_invocation_control(
        "test-invocation".to_owned(),
        "m1".to_owned(),
        HashSet::from(["r1".to_owned(), "r2".to_owned()]),
    );
    runtime
        .shared
        .inner
        .lock()
        .unwrap()
        .invocations
        .insert(control.id.clone(), Arc::clone(&control));
    runtime.seed_running_status("m1", "r1").unwrap();
    runtime.seed_running_status("m1", "r2").unwrap();
    assert!(runtime.begin_role_ownership_transfer("r1").unwrap());
    let recovery_epoch = runtime.fence_role_input("r1").unwrap();

    assert!(runtime
        .require_role_restart_after_navigation_failure("r1", recovery_epoch)
        .unwrap());

    assert!(control.cancelled.load(Ordering::Acquire));
    assert!(runtime.statuses().unwrap().is_empty());
    let role = runtime
        .input_diagnostics()
        .unwrap()
        .roles
        .into_iter()
        .find(|role| role.role_id == "r1")
        .unwrap();
    assert_eq!(role.input_epoch, recovery_epoch);
    assert!(role.quiesced);
    assert!(!role.stopping);
    assert!(role.restart_required);
    assert!(!runtime.resume_role_input("r1", role.input_epoch).unwrap());
    let error = runtime.start(request(Vec::new())).unwrap_err();
    assert_eq!(error.code(), "MACRO_ROLE_INPUT_RESTART_REQUIRED");
    runtime.allow_role_after_launch("r1");
    assert!(!runtime
        .input_diagnostics()
        .unwrap()
        .roles
        .into_iter()
        .find(|role| role.role_id == "r1")
        .unwrap()
        .restart_required);
    let terminal = receiver.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(matches!(
        terminal.as_slice(),
        [CoreEvent::MacroStatuses {
            reliable: true,
            statuses
        }] if statuses.is_empty()
    ));
}

#[test]
fn direct_navigation_failure_supersedes_an_older_input_recovery_atomically() {
    let runtime = MacroRuntime::new(Arc::new(|_| {}));
    let control = new_invocation_control(
        "navigation-failure-invocation".to_owned(),
        "m1".to_owned(),
        HashSet::from(["r1".to_owned()]),
    );
    *control.restart_intent.lock().unwrap() = Some(MacroRestartIntent {
        macro_id: "m1".to_owned(),
        sequence: 1,
        source_role_id: Some("r1".to_owned()),
    });
    runtime
        .shared
        .inner
        .lock()
        .unwrap()
        .invocations
        .insert(control.id.clone(), Arc::clone(&control));
    let recovery = runtime.ensure_input_recovery("older-action", "r1").unwrap();

    runtime
        .terminalize_role_after_navigation_failure("r1")
        .unwrap();

    assert!(control.cancelled.load(Ordering::Acquire));
    assert!(runtime.statuses().unwrap().is_empty());
    assert!(runtime.input_recovery_for_role("r1").unwrap().is_none());
    let diagnostic = runtime
        .input_diagnostics()
        .unwrap()
        .roles
        .into_iter()
        .find(|role| role.role_id == "r1")
        .unwrap();
    assert!(diagnostic.quiesced);
    assert!(diagnostic.restart_required);
    assert!(!diagnostic.stopping);
    assert!(diagnostic.input_epoch > recovery.input_epoch);
    let late = runtime
        .ensure_input_recovery("late-action", "r1")
        .unwrap_err();
    assert_eq!(late.code(), "MACRO_INPUT_RECOVERY_SUPERSEDED");
}

#[test]
fn authoritative_role_release_terminalizes_stopping_input_without_reusing_its_epoch() {
    let runtime = MacroRuntime::new(Arc::new(|_| {}));
    runtime.request_stop_role("r1").unwrap();
    let stopping_epoch = runtime
        .input_diagnostics()
        .unwrap()
        .roles
        .into_iter()
        .find(|role| role.role_id == "r1")
        .unwrap()
        .input_epoch;

    runtime.release_role("r1").unwrap();

    let released = runtime
        .input_diagnostics()
        .unwrap()
        .roles
        .into_iter()
        .find(|role| role.role_id == "r1")
        .unwrap();
    assert!(!released.stopping);
    assert!(!released.quiesced);
    assert!(released.input_epoch > stopping_epoch);
    assert!(!runtime.resume_role_input("r1", stopping_epoch).unwrap());
}

#[test]
fn stale_drain_and_resume_cannot_unfence_a_newer_navigation_epoch() {
    let runtime = MacroRuntime::new(Arc::new(|_| {}));
    let first = runtime.fence_role_input("r1").unwrap();
    let second = runtime.fence_role_input("r1").unwrap();

    assert_eq!((first, second), (1, 2));
    assert!(!runtime.drain_role_input("r1", first).unwrap());
    assert!(!runtime.resume_role_input("r1", first).unwrap());
    assert!(runtime.drain_role_input("r1", second).unwrap());
    assert!(runtime.resume_role_input("r1", second).unwrap());
}

#[test]
fn relaunch_advances_the_epoch_so_late_teardown_cleanup_is_stale() {
    let runtime = MacroRuntime::new(Arc::new(|_| {}));

    runtime.request_stop_role("r1").unwrap();
    let teardown_epoch = runtime
        .shared
        .inner
        .lock()
        .unwrap()
        .input_epochs["r1"];
    runtime.allow_role_after_launch("r1");
    let relaunched_epoch = runtime
        .shared
        .inner
        .lock()
        .unwrap()
        .input_epochs["r1"];

    assert_eq!(relaunched_epoch, teardown_epoch + 1);
    assert!(!runtime.drain_role_input("r1", teardown_epoch).unwrap());
}

#[test]
fn ownership_transfer_preserves_and_resumes_the_active_macro_role_identity() {
    let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
    let runtime = MacroRuntime::new(Arc::new(move |batch| {
        let _ = events.send(batch);
    }));
    let mut start = request(vec![MacroStepDefinition::Key {
        id: "tap".to_owned(),
        code: "KeyX".to_owned(),
        modifiers: None,
        action: Some("tap".to_owned()),
        label: None,
        duration_ms: None,
    }]);
    start.macros[0].repeat = MacroRepeat::Loop { interval_ms: 1_000 };
    let (started, _) = start_and_ack_focus(&runtime, &receiver, start);
    assert_eq!(started.len(), 1);
    let hold = next_browser_actions(&receiver);
    let action_locks = action_role_locks(&runtime.shared, &["r1".to_owned()]).unwrap();
    assert!(matches!(
        action_locks[0].try_lock(),
        Err(std::sync::TryLockError::WouldBlock)
    ));
    runtime.dispatch_results(success_results(hold)).unwrap();
    let release = next_browser_actions(&receiver);
    runtime.dispatch_results(success_results(release)).unwrap();

    assert!(runtime.begin_role_ownership_transfer("r1").unwrap());
    assert!(runtime.role_ownership_transfer_active("r1").unwrap());
    let input_epoch = runtime.fence_role_input("r1").unwrap();
    assert!(runtime.drain_role_input("r1", input_epoch).unwrap());
    assert_eq!(runtime.statuses().unwrap().len(), 1);
    assert!(runtime.resume_role_input("r1", input_epoch).unwrap());
    assert!(!runtime.role_ownership_transfer_active("r1").unwrap());

    let resumed_hold = next_browser_actions(&receiver);
    assert!(resumed_hold
        .iter()
        .all(|action| action.role_id == "r1" && action.input_epoch == input_epoch));
    runtime
        .dispatch_results(success_results(resumed_hold))
        .unwrap();
    let resumed_release = next_browser_actions(&receiver);
    runtime
        .dispatch_results(success_results(resumed_release))
        .unwrap();
    runtime.stop_macro("m1").unwrap();
    assert!(runtime.statuses().unwrap().is_empty());
}

#[test]
fn ownership_transfer_without_active_macro_needs_no_preserved_invocation() {
    let runtime = MacroRuntime::new(Arc::new(|_| {}));

    assert!(!runtime.begin_role_ownership_transfer("r1").unwrap());
    assert!(runtime.role_ownership_transfer_active("r1").unwrap());
    runtime.allow_role_after_launch("r1");
    assert!(!runtime.role_ownership_transfer_active("r1").unwrap());
}

#[test]
fn multi_role_key_sequence_fences_transfer_for_every_target_role() {
    let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
    let runtime = MacroRuntime::new(Arc::new(move |batch| {
        let _ = events.send(batch);
    }));
    let mut start = request(vec![MacroStepDefinition::Key {
        id: "tap".to_owned(),
        code: "KeyX".to_owned(),
        modifiers: None,
        action: Some("tap".to_owned()),
        label: None,
        duration_ms: None,
    }]);
    start.macros[0].role_ids = vec!["r1".to_owned(), "r2".to_owned()];
    start.active_role_ids = vec!["r1".to_owned(), "r2".to_owned()];
    let _ = start_and_ack_focus(&runtime, &receiver, start);
    let holds = [
        next_browser_actions(&receiver),
        next_browser_actions(&receiver),
    ];
    assert!(holds.iter().all(|batch| batch.len() == 1));
    assert!(holds
        .iter()
        .flat_map(|batch| batch.iter())
        .map(|action| action.role_id.as_str())
        .collect::<HashSet<_>>() == HashSet::from(["r1", "r2"]));

    let sequence_locks = input_sequence_role_locks(
        &runtime.shared,
        &["r1".to_owned(), "r2".to_owned()],
    )
    .unwrap();
    assert!(sequence_locks.iter().all(|lock| matches!(
        lock.try_lock(),
        Err(std::sync::TryLockError::WouldBlock)
    )));

    for hold in holds {
        runtime.dispatch_results(success_results(hold)).unwrap();
    }
    let releases = [
        next_browser_actions(&receiver),
        next_browser_actions(&receiver),
    ];
    for release in releases {
        runtime.dispatch_results(success_results(release)).unwrap();
    }
    runtime.stop_macro("m1").unwrap();
}
