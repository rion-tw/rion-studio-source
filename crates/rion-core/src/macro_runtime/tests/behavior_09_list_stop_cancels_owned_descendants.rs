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
