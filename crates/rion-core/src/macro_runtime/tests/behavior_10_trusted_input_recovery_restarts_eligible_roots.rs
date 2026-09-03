#[test]
fn embedded_frame_context_block_captures_root_before_waking_the_failed_action() {
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

    let failure = BrowserActionResult {
        request_id: request_id.clone(),
        ok: false,
        value_json: None,
        error_code: Some("SYSTEM_AUTOMATIC_INPUT_CONTEXT_BLOCKED".to_owned()),
        error_message: Some("embedded frame owns input".to_owned()),
    };
    let accepted = runtime.dispatch_results(vec![failure.clone()]).unwrap();
    assert_eq!(accepted.accepted, vec![request_id.clone()]);
    let duplicate = runtime.dispatch_results(vec![failure]).unwrap();
    assert_eq!(duplicate.duplicate, vec![request_id.clone()]);
    let unknown = runtime
        .dispatch_results(vec![BrowserActionResult {
            request_id: "browser-action-never-emitted".to_owned(),
            ok: true,
            value_json: None,
            error_code: None,
            error_message: None,
        }])
        .unwrap();
    assert_eq!(unknown.unknown, vec!["browser-action-never-emitted"]);
    assert!(starting.join().unwrap().is_err());

    let ticket = runtime
        .input_recovery_for_role("r1")
        .unwrap()
        .expect("recovery ticket");
    assert_eq!(ticket.recovery_id, request_id);
    assert_eq!(ticket.pending_macro_restart_count, 1);
    assert!(
        runtime
            .statuses()
            .unwrap()
            .iter()
            .any(|status| status.macro_id == "m1" && status.state == "recovering")
    );
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
    assert!(
        runtime
            .take_input_recovery(&ticket.recovery_id, "r1")
            .unwrap()
            .is_empty()
    );
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
fn foreground_required_is_an_ordinary_terminal_failure_without_input_recovery() {
    let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
    let runtime = MacroRuntime::new(Arc::new(move |batch| {
        let _ = events.send(batch);
    }));
    let starting_runtime = runtime.clone();
    let starting = thread::spawn(move || {
        starting_runtime.start(request(vec![MacroStepDefinition::Key {
            id: "key-a".to_owned(),
            code: "KeyA".to_owned(),
            modifiers: None,
            action: Some("tap".to_owned()),
            label: Some("A".to_owned()),
            duration_ms: None,
        }]))
    });
    let focus = next_browser_actions(&receiver);
    assert_eq!(focus.len(), 1);
    assert!(matches!(focus[0].action, BrowserAction::Focus));

    runtime
        .dispatch_results(vec![BrowserActionResult {
            request_id: focus[0].request_id.clone(),
            ok: false,
            value_json: None,
            error_code: Some("SYSTEM_TRUSTED_INPUT_FOREGROUND_REQUIRED".to_owned()),
            error_message: Some("target role is hidden or unfocused".to_owned()),
        }])
        .unwrap();

    let error = starting.join().unwrap().unwrap_err();
    assert_eq!(error.code(), "MACRO_INPUT_FAILED");
    assert_eq!(
        error.cause_code(),
        Some("SYSTEM_TRUSTED_INPUT_FOREGROUND_REQUIRED")
    );
    assert!(runtime.statuses().unwrap().is_empty());
    assert!(runtime.input_recovery_for_role("r1").unwrap().is_none());
    let diagnostics = runtime.input_diagnostics().unwrap();
    assert_eq!(diagnostics.active_invocation_count, 0);
    assert_eq!(diagnostics.recent_start_attempts.len(), 1);
    assert_eq!(diagnostics.recent_start_attempts[0].stage, "terminal");
    assert_eq!(diagnostics.recent_start_attempts[0].outcome, "failed");
    assert_eq!(
        diagnostics.recent_start_attempts[0].cause_code.as_deref(),
        Some("SYSTEM_TRUSTED_INPUT_FOREGROUND_REQUIRED")
    );
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
fn newer_navigation_restart_requirement_supersedes_input_recovery() {
    let runtime = MacroRuntime::new(Arc::new(|_| {}));
    {
        let mut inner = runtime.shared.inner.lock().unwrap();
        inner.quiesced_role_ids.insert("r1".to_owned());
        inner.restart_required_role_ids.insert("r1".to_owned());
        inner.input_epochs.insert("r1".to_owned(), 7);
    }

    let error = runtime
        .ensure_input_recovery("late-browser-action", "r1")
        .unwrap_err();
    assert_eq!(error.code(), "MACRO_INPUT_RECOVERY_SUPERSEDED");
    assert!(runtime.input_recovery_for_role("r1").unwrap().is_none());
    let diagnostics = runtime.input_diagnostics().unwrap();
    let role = diagnostics
        .roles
        .iter()
        .find(|role| role.role_id == "r1")
        .unwrap();
    assert!(role.quiesced && role.restart_required);
    assert_eq!(role.input_epoch, 7);
}

#[test]
fn multi_role_recovery_keeps_and_deduplicates_restart_intent_until_every_role_resumes() {
    let runtime = MacroRuntime::new(Arc::new(|_| {}));
    let control = new_invocation_control(
        "macro-invocation-multi".to_owned(),
        "m1".to_owned(),
        HashSet::from(["r1".to_owned(), "r2".to_owned()]),
    );
    *control.restart_intent.lock().unwrap() = Some(MacroRestartIntent {
        macro_id: "m1".to_owned(),
        sequence: 12,
        source_role_id: None,
    });
    runtime
        .shared
        .inner
        .lock()
        .unwrap()
        .invocations
        .insert(control.id.clone(), Arc::clone(&control));

    let first = runtime.ensure_input_recovery("recovery-r1", "r1").unwrap();
    *control.finished.0.lock().unwrap() = true;
    let second = runtime.ensure_input_recovery("recovery-r2", "r2").unwrap();
    let unrelated = new_invocation_control(
        "macro-invocation-unrelated".to_owned(),
        "m2".to_owned(),
        HashSet::from(["r3".to_owned()]),
    );
    *unrelated.restart_intent.lock().unwrap() = Some(MacroRestartIntent {
        macro_id: "m2".to_owned(),
        sequence: 13,
        source_role_id: None,
    });
    runtime
        .shared
        .inner
        .lock()
        .unwrap()
        .invocations
        .insert(unrelated.id.clone(), Arc::clone(&unrelated));
    *unrelated.finished.0.lock().unwrap() = true;
    let unrelated_ticket = runtime.ensure_input_recovery("recovery-r3", "r3").unwrap();
    assert_eq!(
        runtime
            .input_recovery_group_tickets(&first.recovery_id)
            .unwrap()
            .len(),
        2
    );

    assert!(runtime.drain_role_input("r1", first.input_epoch).unwrap());
    assert!(runtime.resume_role_input("r1", first.input_epoch).unwrap());
    assert!(
        runtime
            .input_diagnostics()
            .unwrap()
            .roles
            .iter()
            .any(|role| role.role_id == "r2" && role.quiesced)
    );
    assert!(runtime.drain_role_input("r2", second.input_epoch).unwrap());
    assert!(runtime.resume_role_input("r2", second.input_epoch).unwrap());

    let intents = runtime
        .take_input_recovery_group(&second.recovery_id)
        .unwrap();
    assert_eq!(intents.len(), 1);
    assert_eq!(intents[0].sequence, 12);
    assert!(
        runtime
            .input_recovery_group_tickets(&first.recovery_id)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        runtime
            .input_recovery_group_tickets(&unrelated_ticket.recovery_id)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn failed_recovery_blocks_new_input_until_the_role_relaunches() {
    let runtime = MacroRuntime::new(Arc::new(|_| {}));
    let ticket = runtime.ensure_input_recovery("recovery-9", "r1").unwrap();
    assert!(
        runtime
            .fail_input_recovery(&ticket.recovery_id, "r1", "recovery failed")
            .unwrap()
    );

    let blocked = runtime.start(request(Vec::new())).unwrap_err();
    assert_eq!(blocked.code(), "MACRO_ROLE_INPUT_RESTART_REQUIRED");
    runtime.allow_role_after_launch("r1");
    assert!(runtime.input_recovery_for_role("r1").unwrap().is_none());
}
