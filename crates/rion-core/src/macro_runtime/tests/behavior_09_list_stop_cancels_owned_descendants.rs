#[test]
fn list_stop_waits_for_an_in_flight_start_then_stops_the_registered_run() {
    let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
    let runtime = MacroRuntime::new(Arc::new(move |batch| {
        let _ = events.send(batch);
    }));
    let start_request = request(vec![MacroStepDefinition::Delay {
        id: "wait".to_owned(),
        ms: 60_000,
    }]);
    assert!(start_request.source_role_id.is_none());

    let starting_runtime = runtime.clone();
    let start = thread::spawn(move || starting_runtime.start(start_request));
    let focus = next_browser_actions(&receiver);

    let stopping_runtime = runtime.clone();
    let stop = thread::spawn(move || stopping_runtime.stop_macro("m1"));
    thread::sleep(Duration::from_millis(50));
    assert!(
        !stop.is_finished(),
        "list stop returned before the in-flight list start registered its run"
    );

    runtime.dispatch_results(success_results(focus)).unwrap();
    assert_eq!(start.join().unwrap().unwrap().len(), 1);
    stop.join().unwrap().unwrap();
    assert!(runtime.statuses().unwrap().is_empty());
}

#[test]
fn list_stop_cancels_triggered_and_waited_descendants_before_returning() {
    let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
    let runtime = MacroRuntime::new(Arc::new(move |batch| {
        let _ = events.send(batch);
    }));
    let start_request = list_parent_with_nested_descendants();
    assert!(start_request.source_role_id.is_none());

    let _ = start_and_ack_focus(&runtime, &receiver, start_request);
    for expected_role_id in ["r2", "r3"] {
        let focus = next_browser_actions(&receiver);
        assert_eq!(focus.len(), 1);
        assert_eq!(focus[0].role_id, expected_role_id);
        assert!(matches!(focus[0].action, BrowserAction::Focus));
        runtime.dispatch_results(success_results(focus)).unwrap();
    }
    let hold = next_browser_actions(&receiver);
    assert!(matches!(
        hold[0].action,
        BrowserAction::Key {
            ref code,
            ref phase,
            ..
        } if code.as_deref() == Some("KeyW") && phase == "hold"
    ));
    runtime.dispatch_results(success_results(hold)).unwrap();

    let stopping_runtime = runtime.clone();
    let stop = thread::spawn(move || stopping_runtime.stop_macro("parent"));
    let release = next_browser_actions(&receiver);
    assert_eq!(release.len(), 1);
    assert_eq!(release[0].role_id, "r3");
    assert!(matches!(
        release[0].action,
        BrowserAction::Key {
            ref code,
            ref phase,
            ..
        } if code.as_deref() == Some("KeyW") && phase == "release"
    ));
    runtime.dispatch_results(success_results(release)).unwrap();

    stop.join().unwrap().unwrap();
    assert!(runtime.statuses().unwrap().is_empty());
}

#[test]
fn parent_group_finishes_after_its_finite_triggered_child_terminal_event() {
    let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
    let runtime = MacroRuntime::new(Arc::new(move |batch| {
        let _ = events.send(batch);
    }));
    let _ = start_and_ack_focus(&runtime, &receiver, finite_trigger_parent());

    let child_focus = next_browser_actions(&receiver);
    assert_eq!(child_focus.len(), 1);
    assert_eq!(child_focus[0].role_id, "r2");
    runtime
        .dispatch_results(success_results(child_focus))
        .unwrap();

    let child_hold = next_browser_actions(&receiver);
    assert!(matches!(
        child_hold[0].action,
        BrowserAction::Key {
            ref code,
            ref phase,
            ..
        } if code.as_deref() == Some("KeyB") && phase == "hold"
    ));
    let statuses = runtime.statuses().unwrap();
    assert!(statuses.iter().any(|status| {
        status.macro_id == "parent" && status.state == "running" && status.iteration == Some(1)
    }));
    assert!(
        statuses
            .iter()
            .any(|status| status.macro_id == "child" && status.state == "running")
    );
    runtime
        .dispatch_results(success_results(child_hold))
        .unwrap();

    let child_release = next_browser_actions(&receiver);
    assert!(matches!(
        child_release[0].action,
        BrowserAction::Key {
            ref code,
            ref phase,
            ..
        } if code.as_deref() == Some("KeyB") && phase == "release"
    ));
    runtime
        .dispatch_results(success_results(child_release))
        .unwrap();

    wait_for_empty_reliable_statuses(&receiver);
    assert!(runtime.statuses().unwrap().is_empty());
}

#[test]
fn synchronous_parent_resumes_after_child_execution_while_the_child_group_stays_owned() {
    let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
    let (runtime, waits) = runtime_with_manual_wait(Arc::new(move |batch| {
        let _ = events.send(batch);
    }));
    let _ = start_and_ack_focus(&runtime, &receiver, nested_nonblocking_parent());
    let parent_startup = next_wait(&waits);
    assert_eq!((parent_startup.role_id.as_str(), parent_startup.duration_ms), ("r1", 0));
    parent_startup.release.send(()).unwrap();

    let child_focus = next_browser_actions(&receiver);
    assert_eq!(child_focus[0].role_id, "r2");
    runtime
        .dispatch_results(success_results(child_focus))
        .unwrap();
    let child_startup = next_wait(&waits);
    assert_eq!((child_startup.role_id.as_str(), child_startup.duration_ms), ("r2", 0));
    child_startup.release.send(()).unwrap();

    let grandchild_focus = next_browser_actions(&receiver);
    assert_eq!(grandchild_focus[0].role_id, "r3");
    let parent_wait = next_wait(&waits);
    assert_eq!((parent_wait.role_id.as_str(), parent_wait.duration_ms), ("r1", 60_000));
    runtime
        .dispatch_results(success_results(grandchild_focus))
        .unwrap();
    let grandchild_startup = next_wait(&waits);
    assert_eq!(
        (
            grandchild_startup.role_id.as_str(),
            grandchild_startup.duration_ms
        ),
        ("r3", 0)
    );
    grandchild_startup.release.send(()).unwrap();
    let grandchild_wait = next_wait(&waits);
    assert_eq!(
        (grandchild_wait.role_id.as_str(), grandchild_wait.duration_ms),
        ("r3", 60_000)
    );

    let statuses = runtime.statuses().unwrap();
    assert!(
        ["parent", "child", "grandchild"]
            .iter()
            .all(|macro_id| statuses.iter().any(|status| {
                status.macro_id == *macro_id && status.state == "running"
            }))
    );
    runtime.stop_macro("parent").unwrap();
    assert!(runtime.statuses().unwrap().is_empty());
    drop((parent_wait, grandchild_wait));
}

#[test]
fn stop_after_first_iteration_terminalizes_owned_descendants() {
    let runtime = MacroRuntime::new(Arc::new(|_| {}));
    let parent = new_invocation_control(
        "parent-invocation".to_owned(),
        "parent".to_owned(),
        HashSet::from(["r1".to_owned()]),
    );
    let child = new_invocation_control(
        "child-invocation".to_owned(),
        "child".to_owned(),
        HashSet::from(["r2".to_owned()]),
    );
    {
        let mut inner = runtime.shared.inner.lock().unwrap();
        inner
            .invocations
            .insert(parent.id.clone(), Arc::clone(&parent));
        inner
            .invocations
            .insert(child.id.clone(), Arc::clone(&child));
    }
    register_owned_child(&parent, &child);
    let child_for_worker = Arc::clone(&child);
    let shared_for_worker = Arc::clone(&runtime.shared);
    let worker = thread::spawn(move || {
        let wake = child_for_worker.wake.0.lock().unwrap();
        drop(
            child_for_worker
                .wake
                .1
                .wait_while(wake, |_| !child_for_worker.cancelled.load(Ordering::Acquire))
                .unwrap(),
        );
        finish_invocation(
            &shared_for_worker,
            &child_for_worker,
            Err("macro run cancelled".to_owned()),
        );
    });
    *child.worker.lock().unwrap() = Some(worker);
    parent
        .stop_after_first_iteration
        .store(true, Ordering::Release);

    finish_invocation(&runtime.shared, &parent, Ok(()));

    assert!(child.cancelled.load(Ordering::Acquire));
    assert!(parent.execution_finished.load(Ordering::Acquire));
    assert!(*parent.finished.0.lock().unwrap());
    assert!(*child.finished.0.lock().unwrap());
    assert!(runtime.shared.inner.lock().unwrap().invocations.is_empty());
}

#[test]
fn list_stop_keeps_an_independently_started_same_named_child_running() {
    let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
    let runtime = MacroRuntime::new(Arc::new(move |batch| {
        let _ = events.send(batch);
    }));
    let definitions = independent_child_definitions();
    let active_role_ids = vec!["r1".to_owned(), "r2".to_owned()];
    let settings = MacroRuntimeSettings {
        startup_delay_ms: 0,
        key_hold_ms: 1,
        post_input_delay_ms: 0,
        default_loop_delay_ms: 0,
    };

    let _ = start_and_ack_focus(
        &runtime,
        &receiver,
        MacroStartRequest {
            macros: definitions.clone(),
            settings: settings.clone(),
            macro_id: "child".to_owned(),
            source_role_id: None,
            active_role_ids: active_role_ids.clone(),
        },
    );
    let _ = start_and_ack_focus(
        &runtime,
        &receiver,
        MacroStartRequest {
            macros: definitions,
            settings,
            macro_id: "parent".to_owned(),
            source_role_id: None,
            active_role_ids,
        },
    );

    for expected_phase in ["hold", "release"] {
        let action = next_browser_actions(&receiver);
        assert_eq!(action.len(), 1);
        assert_eq!(action[0].role_id, "r1");
        assert!(matches!(
            action[0].action,
            BrowserAction::Key { ref phase, .. } if phase == expected_phase
        ));
        runtime.dispatch_results(success_results(action)).unwrap();
    }

    runtime.stop_macro("parent").unwrap();
    let statuses = runtime.statuses().unwrap();
    assert_eq!(statuses.len(), 1);
    assert_eq!(statuses[0].macro_id, "child");
    assert_eq!(statuses[0].state, "running");

    runtime.stop_macro("child").unwrap();
}

fn wait_for_empty_reliable_statuses(receiver: &mpsc::Receiver<Vec<CoreEvent>>) {
    loop {
        for event in receiver.recv_timeout(Duration::from_secs(2)).unwrap() {
            if matches!(
                event,
                CoreEvent::MacroStatuses {
                    reliable: true,
                    ref statuses
                } if statuses.is_empty()
            ) {
                return;
            }
        }
    }
}

fn finite_trigger_parent() -> MacroStartRequest {
    MacroStartRequest {
        macros: vec![
            MacroDefinition {
                id: "parent".to_owned(),
                enabled: true,
                activation_mode: Some("toggle".to_owned()),
                name: "Parent".to_owned(),
                role_ids: vec!["r1".to_owned()],
                shortcut_source_scope: Default::default(),
                trigger: None,
                repeat: MacroRepeat::Once,
                steps: vec![MacroStepDefinition::Macro {
                    id: "trigger-child".to_owned(),
                    macro_id: "child".to_owned(),
                    call_mode: Some("trigger".to_owned()),
                }],
            },
            MacroDefinition {
                id: "child".to_owned(),
                enabled: true,
                activation_mode: Some("toggle".to_owned()),
                name: "Child".to_owned(),
                role_ids: vec!["r2".to_owned()],
                shortcut_source_scope: Default::default(),
                trigger: None,
                repeat: MacroRepeat::Once,
                steps: vec![MacroStepDefinition::Key {
                    id: "child-key".to_owned(),
                    code: "KeyB".to_owned(),
                    modifiers: None,
                    action: Some("tap".to_owned()),
                    label: None,
                    duration_ms: None,
                }],
            },
        ],
        settings: MacroRuntimeSettings {
            startup_delay_ms: 0,
            key_hold_ms: 1,
            post_input_delay_ms: 0,
            default_loop_delay_ms: 0,
        },
        macro_id: "parent".to_owned(),
        source_role_id: None,
        active_role_ids: vec!["r1".to_owned(), "r2".to_owned()],
    }
}

fn nested_nonblocking_parent() -> MacroStartRequest {
    MacroStartRequest {
        macros: vec![
            MacroDefinition {
                id: "parent".to_owned(),
                enabled: true,
                activation_mode: Some("toggle".to_owned()),
                name: "Parent".to_owned(),
                role_ids: vec!["r1".to_owned()],
                shortcut_source_scope: Default::default(),
                trigger: None,
                repeat: MacroRepeat::Once,
                steps: vec![
                    MacroStepDefinition::Macro {
                        id: "wait-child".to_owned(),
                        macro_id: "child".to_owned(),
                        call_mode: Some("wait".to_owned()),
                    },
                    MacroStepDefinition::Delay {
                        id: "parent-wait".to_owned(),
                        ms: 60_000,
                    },
                ],
            },
            MacroDefinition {
                id: "child".to_owned(),
                enabled: true,
                activation_mode: Some("toggle".to_owned()),
                name: "Child".to_owned(),
                role_ids: vec!["r2".to_owned()],
                shortcut_source_scope: Default::default(),
                trigger: None,
                repeat: MacroRepeat::Once,
                steps: vec![MacroStepDefinition::Macro {
                    id: "trigger-grandchild".to_owned(),
                    macro_id: "grandchild".to_owned(),
                    call_mode: Some("trigger".to_owned()),
                }],
            },
            MacroDefinition {
                id: "grandchild".to_owned(),
                enabled: true,
                activation_mode: Some("toggle".to_owned()),
                name: "Grandchild".to_owned(),
                role_ids: vec!["r3".to_owned()],
                shortcut_source_scope: Default::default(),
                trigger: None,
                repeat: MacroRepeat::Loop { interval_ms: 0 },
                steps: vec![MacroStepDefinition::Delay {
                    id: "grandchild-wait".to_owned(),
                    ms: 60_000,
                }],
            },
        ],
        settings: MacroRuntimeSettings {
            startup_delay_ms: 0,
            key_hold_ms: 1,
            post_input_delay_ms: 0,
            default_loop_delay_ms: 0,
        },
        macro_id: "parent".to_owned(),
        source_role_id: None,
        active_role_ids: vec!["r1".to_owned(), "r2".to_owned(), "r3".to_owned()],
    }
}

fn list_parent_with_nested_descendants() -> MacroStartRequest {
    MacroStartRequest {
        macros: vec![
            MacroDefinition {
                id: "parent".to_owned(),
                enabled: true,
                activation_mode: Some("toggle".to_owned()),
                name: "Parent".to_owned(),
                role_ids: vec!["r1".to_owned()],
                shortcut_source_scope: Default::default(),
                trigger: None,
                repeat: MacroRepeat::Once,
                steps: vec![
                    MacroStepDefinition::Macro {
                        id: "trigger-child".to_owned(),
                        macro_id: "child".to_owned(),
                        call_mode: Some("trigger".to_owned()),
                    },
                    MacroStepDefinition::Delay {
                        id: "parent-wait".to_owned(),
                        ms: 60_000,
                    },
                ],
            },
            MacroDefinition {
                id: "child".to_owned(),
                enabled: true,
                activation_mode: Some("toggle".to_owned()),
                name: "Child".to_owned(),
                role_ids: vec!["r2".to_owned()],
                shortcut_source_scope: Default::default(),
                trigger: None,
                repeat: MacroRepeat::Once,
                steps: vec![MacroStepDefinition::Macro {
                    id: "wait-grandchild".to_owned(),
                    macro_id: "grandchild".to_owned(),
                    call_mode: Some("wait".to_owned()),
                }],
            },
            MacroDefinition {
                id: "grandchild".to_owned(),
                enabled: true,
                activation_mode: Some("toggle".to_owned()),
                name: "Grandchild".to_owned(),
                role_ids: vec!["r3".to_owned()],
                shortcut_source_scope: Default::default(),
                trigger: None,
                repeat: MacroRepeat::Once,
                steps: vec![MacroStepDefinition::Key {
                    id: "held".to_owned(),
                    code: "KeyW".to_owned(),
                    modifiers: None,
                    action: Some("hold_until_stop".to_owned()),
                    label: None,
                    duration_ms: None,
                }],
            },
        ],
        settings: MacroRuntimeSettings {
            startup_delay_ms: 0,
            key_hold_ms: 0,
            post_input_delay_ms: 0,
            default_loop_delay_ms: 0,
        },
        macro_id: "parent".to_owned(),
        source_role_id: None,
        active_role_ids: vec!["r1".to_owned(), "r2".to_owned(), "r3".to_owned()],
    }
}

fn independent_child_definitions() -> Vec<MacroDefinition> {
    vec![
        MacroDefinition {
            id: "parent".to_owned(),
            enabled: true,
            activation_mode: Some("toggle".to_owned()),
            name: "Parent".to_owned(),
            role_ids: vec!["r1".to_owned()],
            shortcut_source_scope: Default::default(),
            trigger: None,
            repeat: MacroRepeat::Once,
            steps: vec![
                MacroStepDefinition::Macro {
                    id: "trigger-child".to_owned(),
                    macro_id: "child".to_owned(),
                    call_mode: Some("trigger".to_owned()),
                },
                MacroStepDefinition::Key {
                    id: "parent-signal".to_owned(),
                    code: "KeyP".to_owned(),
                    modifiers: None,
                    action: Some("tap".to_owned()),
                    label: None,
                    duration_ms: None,
                },
                MacroStepDefinition::Delay {
                    id: "parent-wait".to_owned(),
                    ms: 60_000,
                },
            ],
        },
        MacroDefinition {
            id: "child".to_owned(),
            enabled: true,
            activation_mode: Some("toggle".to_owned()),
            name: "Child".to_owned(),
            role_ids: vec!["r2".to_owned()],
            shortcut_source_scope: Default::default(),
            trigger: None,
            repeat: MacroRepeat::Once,
            steps: vec![MacroStepDefinition::Delay {
                id: "child-wait".to_owned(),
                ms: 60_000,
            }],
        },
    ]
}
