#[test]
fn application_suspend_fences_cleanup_blocks_new_starts_and_never_replays_the_run() {
    let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
    let runtime = MacroRuntime::new(Arc::new(move |batch| {
        let _ = events.send(batch);
    }));
    start_and_ack_focus(
        &runtime,
        &receiver,
        request(vec![MacroStepDefinition::Key {
            id: "standby-held".to_owned(),
            code: "KeyS".to_owned(),
            modifiers: None,
            action: Some("hold_until_stop".to_owned()),
            label: None,
            duration_ms: None,
        }]),
    );
    let held = next_browser_actions(&receiver);
    assert!(held.iter().all(|action| {
        action.input_epoch == 0
            && action.intent == "normal"
            && matches!(
                action.action,
                BrowserAction::Key {
                    ref phase,
                    ref code,
                    ..
                } if phase == "hold" && code.as_deref() == Some("KeyS")
            )
    }));
    runtime.dispatch_results(success_results(held)).unwrap();

    let suspending = {
        let runtime = runtime.clone();
        thread::spawn(move || runtime.suspend_for_application_lifecycle())
    };
    let cleanup = next_browser_actions(&receiver);
    assert!(cleanup.iter().all(|action| {
        action.input_epoch == 1
            && action.intent == "cleanup"
            && matches!(
                action.action,
                BrowserAction::Key {
                    ref phase,
                    ref code,
                    ..
                } if phase == "release" && code.as_deref() == Some("KeyS")
            )
    }));
    let blocked = runtime.start(request(Vec::new())).unwrap_err();
    assert_eq!(blocked.code(), "MACRO_RUNTIME_NOT_ACTIVE");

    runtime.dispatch_results(success_results(cleanup)).unwrap();
    let suspended = suspending.join().unwrap().unwrap();
    assert_eq!(suspended.len(), 1);
    assert_eq!(suspended[0].role_id, "r1");
    assert_eq!(suspended[0].input_epoch, 1);
    assert!(suspended[0].current);
    assert!(runtime.statuses().unwrap().is_empty());
    let duplicate = runtime.suspend_for_application_lifecycle().unwrap();
    assert_eq!(duplicate.len(), 1);
    assert_eq!(duplicate[0].role_id, suspended[0].role_id);
    assert_eq!(duplicate[0].input_epoch, suspended[0].input_epoch);

    let resumed = runtime.resume_after_application_lifecycle().unwrap();
    assert_eq!(resumed.len(), 1);
    assert_eq!(resumed[0].role_id, suspended[0].role_id);
    assert_eq!(resumed[0].input_epoch, suspended[0].input_epoch);
    assert!(runtime
        .resume_after_application_lifecycle()
        .unwrap()
        .is_empty());
    assert!(!runtime
        .shared
        .application_suspended
        .load(Ordering::Acquire));
    assert!(runtime.statuses().unwrap().is_empty());
}

#[test]
fn stale_wake_epoch_degrades_only_the_exact_role_and_reopens_the_global_lane() {
    let runtime = MacroRuntime::new(Arc::new(|_| {}));
    runtime.seed_running_status("m1", "r1").unwrap();
    let suspended = runtime.suspend_for_application_lifecycle().unwrap();
    assert_eq!(suspended.len(), 1);
    assert_eq!(suspended[0].input_epoch, 1);
    *runtime
        .shared
        .inner
        .lock()
        .unwrap()
        .input_epochs
        .get_mut("r1")
        .unwrap() = 2;

    let error = runtime.resume_after_application_lifecycle().unwrap_err();
    assert_eq!(error.code(), "SYSTEM_LIFECYCLE_INPUT_RESUME_FAILED");
    assert!(!runtime
        .shared
        .application_suspended
        .load(Ordering::Acquire));
    let inner = runtime.shared.inner.lock().unwrap();
    assert!(inner.restart_required_role_ids.contains("r1"));
    assert!(inner.application_suspend_epochs.is_empty());
}

#[test]
fn incomplete_suspend_never_replays_success_and_wake_keeps_roles_restart_required() {
    let runtime = MacroRuntime::new(Arc::new(|_| {}));
    runtime
        .shared
        .application_suspended
        .store(true, Ordering::Release);
    runtime
        .shared
        .application_suspend_completed
        .store(false, Ordering::Release);
    {
        let mut inner = runtime.shared.inner.lock().unwrap();
        inner.application_suspend_epochs.insert("r1".to_owned(), 3);
        inner.input_epochs.insert("r1".to_owned(), 3);
        inner.quiesced_role_ids.insert("r1".to_owned());
    }

    let duplicate = runtime.suspend_for_application_lifecycle().unwrap_err();
    assert_eq!(duplicate.code(), "SYSTEM_LIFECYCLE_INPUT_SUSPEND_FAILED");
    let wake = runtime.resume_after_application_lifecycle().unwrap_err();
    assert_eq!(wake.code(), "SYSTEM_LIFECYCLE_INPUT_SUSPEND_FAILED");
    assert!(!runtime
        .shared
        .application_suspended
        .load(Ordering::Acquire));
    let inner = runtime.shared.inner.lock().unwrap();
    assert!(inner.application_suspend_epochs.is_empty());
    assert!(inner.quiesced_role_ids.contains("r1"));
    assert!(inner.restart_required_role_ids.contains("r1"));
}
