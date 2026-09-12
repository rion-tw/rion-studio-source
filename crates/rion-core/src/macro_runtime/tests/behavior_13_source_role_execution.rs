fn source_request(source: Option<&str>) -> MacroStartRequest {
    let mut request = request(vec![MacroStepDefinition::Delay {
        id: "wait".into(),
        ms: 60_000,
    }]);
    request.macros[0].execution_mode = Some(crate::model::MacroExecutionMode::SourceRole);
    request.macros[0].role_ids.clear();
    request.macros[0].shortcut_source_scope = MacroShortcutSourceScope::AllRoles;
    request.source_role_id = source.map(str::to_owned);
    request.active_role_ids = vec!["r1".into(), "r2".into()];
    request
}

fn admit_source_start(
    runtime: &MacroRuntime,
    receiver: &mpsc::Receiver<Vec<CoreEvent>>,
    request: MacroStartRequest,
) -> Vec<MacroRunStatus> {
    let starting_runtime = runtime.clone();
    let starting = thread::spawn(move || starting_runtime.start(request));
    let focus = next_browser_actions(receiver);
    runtime.dispatch_results(success_results(focus)).unwrap();
    starting.join().unwrap().unwrap()
}

#[test]
fn source_roles_start_press_and_stop_independently() {
    let (events, receiver) = mpsc::channel();
    let (runtime, waits) = runtime_with_manual_wait(Arc::new(move |batch| {
        let _ = events.send(batch);
    }));
    let a = source_request(Some("r1"));
    let b = source_request(Some("r2"));
    assert_eq!(
        admit_source_start(&runtime, &receiver, a.clone())[0].role_id,
        "r1"
    );
    let a_wait = next_wait(&waits);
    assert_eq!(
        admit_source_start(&runtime, &receiver, b.clone())[0].role_id,
        "r2"
    );
    let b_wait = next_wait(&waits);
    assert!(runtime.start(a.clone()).is_err());
    assert_eq!(
        runtime.press(source_request(None)).unwrap_err().code(),
        "MACRO_SOURCE_ROLE_REQUIRED"
    );
    assert_eq!(runtime.statuses().unwrap().len(), 2);
    assert!(runtime.press(a).unwrap().is_empty());
    assert!(
        runtime
            .statuses()
            .unwrap()
            .iter()
            .any(|status| status.role_id == "r2" && status.state == "running")
    );
    runtime.stop_source_macro_from_role("m1", "r2").unwrap();
    assert!(runtime.statuses().unwrap().is_empty());
    drop((a_wait, b_wait));
}

#[test]
fn source_role_admission_rejects_missing_inactive_and_disallowed_sources() {
    let runtime = MacroRuntime::new(Arc::new(|_| {}));
    assert_eq!(
        runtime.start(source_request(None)).unwrap_err().code(),
        "MACRO_SOURCE_ROLE_REQUIRED"
    );
    assert_eq!(
        runtime
            .start(source_request(Some("missing")))
            .unwrap_err()
            .code(),
        "MACRO_SOURCE_ROLE_UNAVAILABLE"
    );
    let mut restricted = source_request(Some("r1"));
    restricted.macros[0].shortcut_source_scope = MacroShortcutSourceScope::SelectedRoles {
        role_ids: vec!["r2".into()],
    };
    assert_eq!(
        runtime.start(restricted).unwrap_err().code(),
        "MACRO_SOURCE_ROLE_UNAVAILABLE"
    );
}

#[test]
fn source_child_requires_original_source_before_any_parent_input() {
    let runtime = MacroRuntime::new(Arc::new(|_| panic!("invalid chain must not dispatch")));
    let mut parent = request(vec![MacroStepDefinition::Macro {
        id: "call".into(),
        macro_id: "child".into(),
        call_mode: None,
    }]);
    let mut child = source_request(None).macros.remove(0);
    child.id = "child".into();
    parent.macros.push(child);
    assert_eq!(
        runtime.start(parent).unwrap_err().code(),
        "MACRO_SOURCE_ROLE_REQUIRED"
    );
}

#[test]
fn source_overlay_is_available_without_fixed_assignments() {
    let request = source_request(Some("r1"));
    assert_eq!(
        crate::overlay::available_macros(&request.macros, "r1").len(),
        1
    );
    assert!(crate::overlay::ensure_macro_available(&request.macros, "r2", "m1").is_ok());
}

#[test]
fn source_role_held_release_and_stale_release_do_not_cancel_another_role() {
    let (events, receiver) = mpsc::channel();
    let (runtime, waits) = runtime_with_manual_wait(Arc::new(move |batch| {
        let _ = events.send(batch);
    }));
    let mut held_waits = Vec::new();
    for role in ["r1", "r2"] {
        let mut start = source_request(Some(role));
        start.macros[0].activation_mode = Some(MacroActivationMode::Hold);
        let pressing_runtime = runtime.clone();
        let pressing = thread::spawn(move || {
            pressing_runtime.hold_start(MacroHoldStartRequest {
                start,
                shortcut_cycle_id: "press".into(),
            })
        });
        let focus = next_browser_actions(&receiver);
        runtime.dispatch_results(success_results(focus)).unwrap();
        pressing.join().unwrap().unwrap();
        // Keep the external test acknowledgement pending until cancellation.
        held_waits.push(next_wait(&waits));
    }
    runtime
        .hold_release(MacroHoldReleaseRequest {
            macro_id: "m1".into(),
            source_role_id: "r1".into(),
            shortcut_cycle_id: "stale".into(),
        })
        .unwrap();
    assert_eq!(runtime.statuses().unwrap().len(), 2);
    runtime
        .hold_release(MacroHoldReleaseRequest {
            macro_id: "m1".into(),
            source_role_id: "r1".into(),
            shortcut_cycle_id: "press".into(),
        })
        .unwrap();
    assert!(
        runtime
            .statuses()
            .unwrap()
            .iter()
            .any(|status| status.role_id == "r2" && status.state == "running")
    );
    runtime.stop_macro("m1").unwrap();
    assert!(runtime.statuses().unwrap().is_empty());
}

#[test]
fn source_child_uses_original_role_instead_of_fixed_parent_target() {
    let (events, receiver) = mpsc::channel();
    let (runtime, waits) = runtime_with_manual_wait(Arc::new(move |batch| {
        let _ = events.send(batch);
    }));
    let mut start = request(vec![MacroStepDefinition::Macro {
        id: "call".into(),
        macro_id: "child".into(),
        call_mode: None,
    }]);
    start.active_role_ids = vec!["r1".into(), "r2".into()];
    start.source_role_id = Some("r1".into());
    start.macros[0].role_ids = vec!["r2".into()];
    start.macros[0].shortcut_source_scope = MacroShortcutSourceScope::SelectedRoles {
        role_ids: vec!["r1".into()],
    };
    let mut child = source_request(Some("r1")).macros.remove(0);
    child.id = "child".into();
    start.macros.push(child);
    assert_eq!(
        admit_source_start(&runtime, &receiver, start)[0].role_id,
        "r2"
    );
    let parent_startup = next_wait(&waits);
    assert_eq!(parent_startup.duration_ms, 0);
    parent_startup.release.send(()).unwrap();
    let child_focus = next_browser_actions(&receiver);
    assert!(child_focus.iter().all(|action| action.role_id == "r1"));
    runtime
        .dispatch_results(success_results(child_focus))
        .unwrap();
    let child_wait = next_wait(&waits);
    assert_eq!(child_wait.role_id, "r1");
    runtime.stop_macro("m1").unwrap();
    assert!(runtime.statuses().unwrap().is_empty());
    drop(child_wait);
}

#[test]
fn source_stop_preserves_other_roles_pending_recovery() {
    let runtime = MacroRuntime::new(Arc::new(|_| {}));
    for (sequence, role) in [(1, "r1"), (2, "r2")] {
        runtime
            .shared
            .inner
            .lock()
            .unwrap()
            .input_recoveries
            .insert(
                role.into(),
                MacroInputRecovery {
                    input_epoch: sequence,
                    intents: vec![MacroRestartIntent {
                        macro_id: "m1".into(),
                        sequence,
                        source_role_id: Some(role.into()),
                    }],
                    role_id: role.into(),
                },
            );
        runtime.seed_running_status("m1", role).unwrap();
    }
    runtime.stop_source_macro_from_role("m1", "r1").unwrap();
    let inner = runtime.shared.inner.lock().unwrap();
    assert!(inner.input_recoveries["r1"].intents.is_empty());
    assert_eq!(inner.input_recoveries["r2"].intents.len(), 1);
    assert_eq!(
        inner.input_recoveries["r2"].intents[0]
            .source_role_id
            .as_deref(),
        Some("r2")
    );
    assert!(inner.statuses.values().all(|status| status.role_id == "r2"));
}
