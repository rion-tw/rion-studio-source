#[test]
fn trusted_input_indeterminate_captures_root_before_waking_the_failed_action() {
    let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
    let runtime = MacroRuntime::new(Arc::new(move |batch| {
        let _ = events.send(batch);
    }));
    let mut start = request(vec![MacroStepDefinition::Delay {
        id: "wait".to_owned(),
        ms: 60_000,
    }]);
    start.source_role_id = Some("r1".to_owned());
    let starting_runtime = runtime.clone();
    let starting = thread::spawn(move || starting_runtime.start(start));
    let focus = next_browser_actions(&receiver);
    let request_id = focus[0].request_id.clone();

    runtime
        .dispatch_results(vec![BrowserActionResult {
            request_id: request_id.clone(),
            ok: false,
            value_json: None,
            error_code: Some("SYSTEM_TRUSTED_INPUT_INDETERMINATE".to_owned()),
            error_message: Some("native acknowledgement missing".to_owned()),
        }])
        .unwrap();
    assert!(starting.join().unwrap().is_err());

    let ticket = runtime
        .input_recovery_for_role("r1")
        .unwrap()
        .expect("recovery ticket");
    assert_eq!(ticket.recovery_id, request_id);
    assert_eq!(ticket.pending_macro_restart_count, 1);
    assert!(runtime
        .statuses()
        .unwrap()
        .iter()
        .any(|status| status.macro_id == "m1" && status.state == "recovering"));
    let blocked = runtime.start(request(Vec::new())).unwrap_err();
    assert_eq!(blocked.code(), "MACRO_ROLE_INPUT_RECOVERING");

    assert!(runtime.drain_role_input("r1", ticket.input_epoch).unwrap());
    assert!(runtime.resume_role_input("r1", ticket.input_epoch).unwrap());
    let intents = runtime
        .take_input_recovery(&ticket.recovery_id, "r1")
        .unwrap();
    assert_eq!(intents.len(), 1);
    assert_eq!(intents[0].macro_id, "m1");
    assert_eq!(intents[0].source_role_id.as_deref(), Some("r1"));
    assert!(runtime.statuses().unwrap().is_empty());
    assert!(runtime
        .take_input_recovery(&ticket.recovery_id, "r1")
        .unwrap()
        .is_empty());
}

#[test]
fn while_held_input_recovery_does_not_create_a_restart_intent() {
    let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
    let runtime = MacroRuntime::new(Arc::new(move |batch| {
        let _ = events.send(batch);
    }));
    let mut start = request(vec![MacroStepDefinition::Delay {
        id: "wait".to_owned(),
        ms: 60_000,
    }]);
    start.macros[0].activation_mode = Some("while_held".to_owned());
    start.source_role_id = Some("r1".to_owned());
    let pressing_runtime = runtime.clone();
    let pressing = thread::spawn(move || {
        pressing_runtime.press(MacroPressRequest {
            start,
            press_id: "held-recovery".to_owned(),
        })
    });
    let focus = next_browser_actions(&receiver);
    runtime
        .dispatch_results(vec![BrowserActionResult {
            request_id: focus[0].request_id.clone(),
            ok: false,
            value_json: None,
            error_code: Some("SYSTEM_TRUSTED_INPUT_INDETERMINATE".to_owned()),
            error_message: Some("native acknowledgement missing".to_owned()),
        }])
        .unwrap();
    assert!(pressing.join().unwrap().is_err());
    let ticket = runtime
        .input_recovery_for_role("r1")
        .unwrap()
        .expect("recovery ticket");
    assert_eq!(ticket.pending_macro_restart_count, 0);
    assert!(runtime.statuses().unwrap().is_empty());
}

#[test]
fn manual_stop_cancels_a_pending_restart_without_cancelling_role_recovery() {
    let runtime = MacroRuntime::new(Arc::new(|_| {}));
    let control = new_invocation_control(
        "macro-invocation-7".to_owned(),
        "m1".to_owned(),
        HashSet::from(["r1".to_owned(), "r2".to_owned()]),
    );
    *control.restart_intent.lock().unwrap() = Some(MacroRestartIntent {
        macro_id: "m1".to_owned(),
        sequence: 7,
        source_role_id: None,
    });
    runtime
        .shared
        .inner
        .lock()
        .unwrap()
        .invocations
        .insert(control.id.clone(), Arc::clone(&control));

    let ticket = runtime.ensure_input_recovery("recovery-7", "r1").unwrap();
    assert_eq!(ticket.pending_macro_restart_count, 1);
    *control.finished.0.lock().unwrap() = true;
    runtime.stop_macro("m1").unwrap();
    let active = runtime
        .input_recovery_for_role("r1")
        .unwrap()
        .expect("surface recovery remains active");
    assert_eq!(active.pending_macro_restart_count, 0);
}

#[test]
fn repeated_recovery_requests_replay_the_active_role_ticket() {
    let runtime = MacroRuntime::new(Arc::new(|_| {}));
    let control = new_invocation_control(
        "macro-invocation-8".to_owned(),
        "m1".to_owned(),
        HashSet::from(["r1".to_owned()]),
    );
    *control.restart_intent.lock().unwrap() = Some(MacroRestartIntent {
        macro_id: "m1".to_owned(),
        sequence: 8,
        source_role_id: None,
    });
    runtime
        .shared
        .inner
        .lock()
        .unwrap()
        .invocations
        .insert(control.id.clone(), control);

    let first = runtime.ensure_input_recovery("recovery-8", "r1").unwrap();
    let replay = runtime
        .ensure_input_recovery("different-request", "r1")
        .unwrap();
    assert_eq!(replay, first);
}

#[test]
fn failed_recovery_blocks_new_input_until_the_role_relaunches() {
    let runtime = MacroRuntime::new(Arc::new(|_| {}));
    let ticket = runtime.ensure_input_recovery("recovery-9", "r1").unwrap();
    assert!(runtime
        .fail_input_recovery(&ticket.recovery_id, "r1", "recovery failed")
        .unwrap());

    let blocked = runtime.start(request(Vec::new())).unwrap_err();
    assert_eq!(blocked.code(), "MACRO_ROLE_INPUT_RESTART_REQUIRED");
    runtime.allow_role_after_launch("r1");
    assert!(runtime.input_recovery_for_role("r1").unwrap().is_none());
}
