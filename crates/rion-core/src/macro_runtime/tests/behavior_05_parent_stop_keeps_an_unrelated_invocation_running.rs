#[test]
    fn parent_stop_keeps_an_unrelated_invocation_running() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let parent = MacroDefinition {
            id: "parent".to_owned(),
            enabled: true,
            activation_mode: Some("toggle".to_owned()),
            name: "Parent".to_owned(),
            role_ids: vec!["r1".to_owned()],
            shortcut_source_scope: Default::default(),
            trigger: None,
            repeat: MacroRepeat::Once,
            steps: vec![MacroStepDefinition::Macro {
                id: "call-child".to_owned(),
                macro_id: "child".to_owned(),
                call_mode: Some("wait".to_owned()),
            }],
        };
        let child = MacroDefinition {
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
        };
        let unrelated = MacroDefinition {
            id: "unrelated".to_owned(),
            enabled: true,
            activation_mode: Some("toggle".to_owned()),
            name: "Unrelated".to_owned(),
            role_ids: vec!["r3".to_owned()],
            shortcut_source_scope: Default::default(),
            trigger: None,
            repeat: MacroRepeat::Once,
            steps: vec![MacroStepDefinition::Delay {
                id: "unrelated-wait".to_owned(),
                ms: 60_000,
            }],
        };
        let base = MacroStartRequest {
            macros: vec![parent, child, unrelated],
            settings: MacroRuntimeSettings {
                startup_delay_ms: 0,
                key_hold_ms: 0,
                post_input_delay_ms: 0,
                default_loop_delay_ms: 0,
            },
            macro_id: "unrelated".to_owned(),
            source_role_id: None,
            active_role_ids: vec!["r1".to_owned(), "r2".to_owned(), "r3".to_owned()],
        };
        let _ = start_and_ack_focus(&runtime, &receiver, base.clone());
        let _ = start_and_ack_focus(
            &runtime,
            &receiver,
            MacroStartRequest {
                macro_id: "parent".to_owned(),
                ..base
            },
        );
        let child_focus = next_browser_actions(&receiver);
        assert_eq!(child_focus[0].role_id, "r2");
        runtime
            .dispatch_results(success_results(child_focus))
            .unwrap();
        runtime.stop_macro("parent").unwrap();
        {
            assert_eq!(
                runtime
                    .statuses()
                    .unwrap()
                    .iter()
                    .map(|status| (status.macro_id.as_str(), status.state.as_str()))
                    .collect::<Vec<_>>(),
                [("unrelated", "running")]
            );
        };
        runtime.stop_macro("unrelated").unwrap();
    }

    #[test]
    fn calls_a_run_once_child_on_every_parent_loop_iteration() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let (runtime, waits) = runtime_with_manual_wait(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![MacroStepDefinition::Macro {
            id: "call-child".to_owned(),
            macro_id: "child".to_owned(),
            call_mode: Some("wait".to_owned()),
        }]);
        start.macros[0].repeat = MacroRepeat::Loop { interval_ms: 1 };
        start.macros.push(MacroDefinition {
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
        });
        start.active_role_ids.push("r2".to_owned());
        let _ = start_and_ack_focus(&runtime, &receiver, start);
        let parent_startup = next_wait(&waits);
        assert_eq!(parent_startup.duration_ms, 0);
        parent_startup.release.send(()).unwrap();
        let mut child_holds = 0;
        for iteration in 0..2 {
            for expected in ["focus", "hold", "release"] {
                let action = next_browser_actions(&receiver);
                assert!(match (&action[0].action, expected) {
                    (BrowserAction::Focus, "focus") => true,
                    (BrowserAction::Key { phase, .. }, phase_expected) => {
                        phase == phase_expected
                    }
                    _ => false,
                });
                if expected == "focus" {
                    runtime.dispatch_results(success_results(action)).unwrap();
                    let child_startup = next_wait(&waits);
                    assert_eq!(child_startup.duration_ms, 0);
                    child_startup.release.send(()).unwrap();
                    continue;
                }
                if expected == "hold" {
                    child_holds += 1;
                }
                runtime.dispatch_results(success_results(action)).unwrap();
                let child_timing = next_wait(&waits);
                assert_eq!(
                    child_timing.duration_ms,
                    if expected == "hold" { 1 } else { 0 }
                );
                child_timing.release.send(()).unwrap();
            }
            let loop_wait = next_wait(&waits);
            assert_eq!(loop_wait.duration_ms, 1);
            if iteration == 0 {
                loop_wait.release.send(()).unwrap();
            } else {
                {
                    assert_eq!(child_holds, 2);
                };
                runtime.stop_macro("m1").unwrap();
                drop(loop_wait);
            }
        }
    }

    #[test]
    fn triggered_child_keeps_its_configured_loop_after_parent_completion() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![
            MacroStepDefinition::Macro {
                id: "trigger-child".to_owned(),
                macro_id: "child".to_owned(),
                call_mode: Some("trigger".to_owned()),
            },
            MacroStepDefinition::Delay {
                id: "wait-before-duplicate".to_owned(),
                ms: 20,
            },
            MacroStepDefinition::Macro {
                id: "duplicate-trigger".to_owned(),
                macro_id: "child".to_owned(),
                call_mode: Some("trigger".to_owned()),
            },
        ]);
        start.macros.push(MacroDefinition {
            id: "child".to_owned(),
            enabled: true,
            activation_mode: Some("toggle".to_owned()),
            name: "Child".to_owned(),
            role_ids: vec!["r2".to_owned()],
            shortcut_source_scope: Default::default(),
            trigger: None,
            repeat: MacroRepeat::Loop { interval_ms: 1_000 },
            steps: vec![MacroStepDefinition::Key {
                id: "child-key".to_owned(),
                code: "KeyB".to_owned(),
                modifiers: None,
                action: Some("tap".to_owned()),
                label: None,
                duration_ms: None,
            }],
        });
        start.active_role_ids.push("r2".to_owned());
        let _ = start_and_ack_focus(&runtime, &receiver, start);

        for _ in 0..3 {
            let batch = next_browser_actions(&receiver);
            runtime.dispatch_results(success_results(batch)).unwrap();
        }
        {
            let wait_started = std::time::Instant::now();
            loop {
                let statuses = runtime.statuses().unwrap();
                if statuses.iter().any(|status| status.macro_id == "child")
                    && statuses.iter().all(|status| status.macro_id != "m1")
                {
                    break;
                }
                assert!(wait_started.elapsed() < Duration::from_secs(2));
                thread::yield_now();
            }
        };
        {
            assert!(
                runtime
                    .statuses()
                    .unwrap()
                    .iter()
                    .any(|status| status.macro_id == "child" && status.state == "running")
            );
        };
        {
            assert_eq!(
                runtime
                    .statuses()
                    .unwrap()
                    .iter()
                    .filter(|status| status.macro_id == "child")
                    .count(),
                1
            );
        };
        runtime.stop_macro("child").unwrap();
        assert!(runtime.statuses().unwrap().is_empty());
    }

    #[test]
    fn stopping_parent_recursively_stops_triggered_held_child() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![
            MacroStepDefinition::Macro {
                id: "trigger-child".to_owned(),
                macro_id: "child".to_owned(),
                call_mode: Some("trigger".to_owned()),
            },
            MacroStepDefinition::Delay {
                id: "wait".to_owned(),
                ms: 1_000,
            },
        ]);
        start.macros.push(MacroDefinition {
            id: "child".to_owned(),
            enabled: true,
            activation_mode: Some("toggle".to_owned()),
            name: "Child".to_owned(),
            role_ids: vec!["r2".to_owned()],
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
        });
        start.active_role_ids.push("r2".to_owned());
        let _ = start_and_ack_focus(&runtime, &receiver, start);
        let child_focus = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(child_focus))
            .unwrap();
        let child_hold = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(child_hold))
            .unwrap();

        let stopping_runtime = runtime.clone();
        let stop = thread::spawn(move || stopping_runtime.stop_macro("m1").unwrap());
        let release = next_browser_actions(&receiver);
        {
            assert_eq!(release.len(), 1);
            assert!(matches!(
                release[0].action,
                BrowserAction::Key {
                    ref phase,
                    ..
                } if phase == "release"
            ));
        };
        {
            assert_eq!(release[0].role_id, "r2");
            assert!(matches!(
                release[0].action,
                BrowserAction::Key {
                    ref code,
                    ref phase,
                    ..
                } if code.as_deref() == Some("KeyW") && phase == "release"
            ));
        };
        runtime.dispatch_results(success_results(release)).unwrap();
        stop.join().unwrap();
        assert!(runtime.statuses().unwrap().is_empty());
    }

    #[test]
    fn stops_a_triggered_child_when_the_parent_role_closes() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let _ = start_and_ack_focus(&runtime, &receiver, triggered_delay_request());
        let child_focus = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(child_focus))
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while !runtime
            .statuses()
            .unwrap()
            .iter()
            .any(|status| status.macro_id == "child" && status.state == "running")
        {
            assert!(std::time::Instant::now() < deadline);
            thread::yield_now();
        }
        runtime.stop_role("r1").unwrap();
        {
            assert!(runtime.statuses().unwrap().is_empty());
        };
    }

    #[test]
    fn parent_stop_waits_for_a_pending_triggered_child_focus_result() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let _ = start_and_ack_focus(&runtime, &receiver, triggered_delay_request());
        let child_focus = next_browser_actions(&receiver);

        let stopping_runtime = runtime.clone();
        let stop = thread::spawn(move || stopping_runtime.stop_macro("m1").unwrap());
        thread::sleep(Duration::from_millis(25));
        {
            assert!(!stop.is_finished());
        };
        runtime
            .dispatch_results(success_results(child_focus))
            .unwrap();
        stop.join().unwrap();
        assert!(runtime.statuses().unwrap().is_empty());
    }

    #[test]
    fn keeps_the_parent_running_when_a_triggered_child_fails() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let (runtime, waits) = runtime_with_manual_wait(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = triggered_delay_request();
        start.macros[1].steps = vec![MacroStepDefinition::Key {
            id: "fail".to_owned(),
            code: "KeyF".to_owned(),
            modifiers: None,
            action: Some("tap".to_owned()),
            label: None,
            duration_ms: None,
        }];
        let _ = start_and_ack_focus(&runtime, &receiver, start);
        let parent_startup = next_wait(&waits);
        assert_eq!(parent_startup.duration_ms, 0);
        parent_startup.release.send(()).unwrap();
        let parent_wait = next_wait(&waits);
        assert_eq!(parent_wait.role_id, "r1");
        assert_eq!(parent_wait.duration_ms, 60_000);
        let child_focus = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(child_focus))
            .unwrap();
        let child_startup = next_wait(&waits);
        assert_eq!((child_startup.role_id.as_str(), child_startup.duration_ms), ("r2", 0));
        child_startup.release.send(()).unwrap();
        let child_hold = next_browser_actions(&receiver);
        runtime
            .dispatch_results(vec![BrowserActionResult {
                request_id: child_hold[0].request_id.clone(),
                ok: false,
                value_json: None,
                error_code: Some("CHILD_FAILED".to_owned()),
                error_message: Some("child failed".to_owned()),
            }])
            .unwrap();
        let release = next_browser_actions(&receiver);
        runtime.dispatch_results(success_results(release)).unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            let statuses = runtime.statuses().unwrap();
            if statuses.iter().any(|status| {
                status.macro_id == "child"
                    && status.state == "failed"
                    && status.error.as_deref() == Some("child failed")
            }) {
                {
                    assert!(
                        statuses
                            .iter()
                            .any(|status| { status.macro_id == "m1" && status.state == "running" })
                    );
                };
                break;
            }
            assert!(std::time::Instant::now() < deadline);
            thread::yield_now();
        }
        runtime.stop_macro("m1").unwrap();
        drop(parent_wait);
        assert!(runtime.statuses().unwrap().iter().any(|status| {
            status.macro_id == "child"
                && status.state == "failed"
                && status.error.as_deref() == Some("child failed")
        }));
        runtime.stop_macro("child").unwrap();
    }

    #[test]
    fn stops_an_active_triggered_child_when_the_parent_fails() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![
            MacroStepDefinition::Macro {
                id: "trigger-child".to_owned(),
                macro_id: "child".to_owned(),
                call_mode: Some("trigger".to_owned()),
            },
            MacroStepDefinition::Key {
                id: "parent-fail".to_owned(),
                code: "KeyF".to_owned(),
                modifiers: None,
                action: Some("tap".to_owned()),
                label: None,
                duration_ms: None,
            },
        ]);
        start.macros.push(MacroDefinition {
            id: "child".to_owned(),
            enabled: true,
            activation_mode: Some("toggle".to_owned()),
            name: "Held child".to_owned(),
            role_ids: vec!["r2".to_owned()],
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
        });
        start.active_role_ids.push("r2".to_owned());
        let _ = start_and_ack_focus(&runtime, &receiver, start);

        let mut parent_hold = None;
        let mut child_held = false;
        while parent_hold.is_none() || !child_held {
            let actions = next_browser_actions(&receiver);
            for action in actions {
                match (&action.role_id[..], &action.action) {
                    ("r1", BrowserAction::Key { phase, .. }) if phase == "hold" => {
                        parent_hold = Some(action);
                    }
                    ("r2", BrowserAction::Key { phase, .. }) if phase == "hold" => {
                        child_held = true;
                        runtime
                            .dispatch_results(success_results(vec![action]))
                            .unwrap();
                    }
                    ("r2", BrowserAction::Focus) => {
                        runtime
                            .dispatch_results(success_results(vec![action]))
                            .unwrap();
                    }
                    (_, action) => panic!("unexpected pre-failure action: {action:?}"),
                }
            }
        }
        let parent_hold = parent_hold.unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while !runtime
            .statuses()
            .unwrap()
            .iter()
            .any(|status| status.macro_id == "child" && status.iteration.unwrap_or_default() > 0)
        {
            assert!(std::time::Instant::now() < deadline);
            thread::yield_now();
        }
        runtime
            .dispatch_results(vec![BrowserActionResult {
                request_id: parent_hold.request_id,
                ok: false,
                value_json: None,
                error_code: Some("PARENT_FAILED".to_owned()),
                error_message: Some("parent failed".to_owned()),
            }])
            .unwrap();
        let parent_release = next_browser_actions(&receiver);
        assert_eq!(parent_release[0].role_id, "r1");
        runtime
            .dispatch_results(success_results(parent_release))
            .unwrap();
        let child_release = loop {
            match receiver.recv_timeout(Duration::from_millis(250)) {
                Ok(events) => {
                    if let Some(actions) = events.into_iter().find_map(|event| match event {
                        CoreEvent::BrowserActions { actions } => Some(actions),
                        _ => None,
                    }) {
                        break actions;
                    }
                }
                Err(error) => panic!(
                    "missing child release after parent failure ({error:?}): {:?}",
                    runtime.statuses().unwrap()
                ),
            }
        };
        assert_eq!(child_release[0].role_id, "r2");
        runtime
            .dispatch_results(success_results(child_release))
            .unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            let statuses = runtime.statuses().unwrap();
            if statuses.len() == 1 && statuses[0].macro_id == "m1" && statuses[0].state == "failed"
            {
                {
                    assert_eq!(statuses[0].error.as_deref(), Some("parent failed"));
                    assert!(statuses.iter().all(|status| status.macro_id != "child"));
                };
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "triggered child did not stop with failed parent: {statuses:?}"
            );
            thread::yield_now();
        }
        runtime.stop_macro("m1").unwrap();
    }

    #[test]
    fn continues_the_parent_when_a_triggered_child_cannot_start() {
        for (child_enabled, child_active, case_id) in [
            (false, true, "macro-4f6ff4a65685"),
            (true, false, "macro-16bfa0b6fc25"),
        ] {
            let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
            let runtime = MacroRuntime::new(Arc::new(move |batch| {
                let _ = events.send(batch);
            }));
            let mut start = request(vec![
                MacroStepDefinition::Macro {
                    id: "trigger-child".to_owned(),
                    macro_id: "child".to_owned(),
                    call_mode: Some("trigger".to_owned()),
                },
                MacroStepDefinition::Key {
                    id: "after".to_owned(),
                    code: "KeyC".to_owned(),
                    modifiers: None,
                    action: Some("tap".to_owned()),
                    label: None,
                    duration_ms: None,
                },
            ]);
            start.macros.push(MacroDefinition {
                id: "child".to_owned(),
                enabled: child_enabled,
                activation_mode: Some("toggle".to_owned()),
                name: "Child".to_owned(),
                role_ids: vec!["r2".to_owned()],
                shortcut_source_scope: Default::default(),
                trigger: None,
                repeat: MacroRepeat::Once,
                steps: vec![],
            });
            if child_active {
                start.active_role_ids.push("r2".to_owned());
            }
            let _ = start_and_ack_focus(&runtime, &receiver, start);
            let parent_hold = next_browser_actions(&receiver);
            assert!(matches!(
                parent_hold[0].action,
                BrowserAction::Key {
                    ref code,
                    ref phase,
                    ..
                } if code.as_deref() == Some("KeyC") && phase == "hold"
            ));
            runtime
                .dispatch_results(success_results(parent_hold))
                .unwrap();
            let parent_release = next_browser_actions(&receiver);
            runtime
                .dispatch_results(success_results(parent_release))
                .unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            while runtime
                .statuses()
                .unwrap()
                .iter()
                .any(|status| status.macro_id == "m1")
            {
                assert!(std::time::Instant::now() < deadline);
                thread::yield_now();
            }
            match case_id {
                "macro-4f6ff4a65685" => {
                    {
                        assert!(runtime.statuses().unwrap().is_empty());
                    };
                }
                "macro-16bfa0b6fc25" => {
                    {
                        assert!(runtime.statuses().unwrap().is_empty());
                    };
                }
                _ => unreachable!(),
            }
        }
    }
