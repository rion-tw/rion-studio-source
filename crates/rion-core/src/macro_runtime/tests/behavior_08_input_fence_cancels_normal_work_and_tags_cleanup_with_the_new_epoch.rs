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
    assert_eq!(error.code(), "MACRO_ROLE_STOPPING");
    assert!(runtime.resume_role_input("r1", input_epoch).unwrap());
    assert!(!runtime
        .shared
        .inner
        .lock()
        .unwrap()
        .quiesced_role_ids
        .contains("r1"));
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
