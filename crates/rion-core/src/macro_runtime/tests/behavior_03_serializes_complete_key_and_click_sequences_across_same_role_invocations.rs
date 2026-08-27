#[test]
    fn serializes_complete_key_and_click_sequences_across_same_role_invocations() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let (runtime, waits) = runtime_with_manual_wait(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut first = request(vec![MacroStepDefinition::Key {
            id: "first-key".to_owned(),
            code: "F2".to_owned(),
            modifiers: None,
            action: Some("tap".to_owned()),
            label: None,
            duration_ms: None,
        }]);
        first.macros[0].trigger = Some(crate::model::MacroTrigger::Keyboard {
            code: "KeyQ".to_owned(),
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
        });
        first.settings = MacroRuntimeSettings {
            startup_delay_ms: 0,
            key_hold_ms: 0,
            post_input_delay_ms: 100,
            default_loop_delay_ms: 0,
        };
        let _ = start_and_ack_focus(&runtime, &receiver, first);
        let startup = next_wait(&waits);
        assert_eq!(startup.duration_ms, 0);
        startup.release.send(()).unwrap();
        let key_hold = next_browser_actions(&receiver);
        runtime.dispatch_results(success_results(key_hold)).unwrap();
        let hold_wait = next_wait(&waits);
        assert_eq!(hold_wait.duration_ms, 0);
        hold_wait.release.send(()).unwrap();
        let key_release = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(key_release))
            .unwrap();
        let post_input = next_wait(&waits);
        assert_eq!(post_input.duration_ms, 100);

        let mut second = request(vec![MacroStepDefinition::Click {
            button: Some("middle".to_owned()),
            id: "second-click".to_owned(),
            anchor: None,
            position: crate::model::MacroClickDefinition::Percent {
                unit: Some("percent".to_owned()),
                x_percent: 20.0,
                y_percent: 30.0,
            },
        }]);
        second.macro_id = "m2".to_owned();
        second.macros[0].id = "m2".to_owned();
        let second_runtime = runtime.clone();
        let second_start = thread::spawn(move || second_runtime.start(second).unwrap());
        let second_focus = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(second_focus))
            .unwrap();
        second_start.join().unwrap();
        let second_startup = next_wait(&waits);
        assert_eq!(second_startup.duration_ms, 0);
        second_startup.release.send(()).unwrap();
        {
            assert_no_browser_actions(&receiver, Duration::from_millis(25));
        };
        {
            assert_no_browser_actions(&receiver, Duration::from_millis(25));
        };

        post_input.release.send(()).unwrap();
        let click = next_browser_actions(&receiver);
        assert!(matches!(
            &click[0].action,
            BrowserAction::Click { button, .. } if button == "middle"
        ));
        runtime.dispatch_results(success_results(click)).unwrap();
        let click_post_input = next_wait(&waits);
        assert_eq!(click_post_input.duration_ms, 0);
        click_post_input.release.send(()).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while !runtime.statuses().unwrap().is_empty() {
            assert!(std::time::Instant::now() < deadline);
            thread::yield_now();
        }
    }

    #[test]
    fn serializes_concurrent_key_sequences_for_the_same_role() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let (runtime, waits) = runtime_with_manual_wait(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut first = request(vec![MacroStepDefinition::Key {
            id: "first-key".to_owned(),
            code: "F2".to_owned(),
            modifiers: None,
            action: Some("tap".to_owned()),
            label: None,
            duration_ms: None,
        }]);
        first.macros[0].trigger = Some(crate::model::MacroTrigger::Keyboard {
            code: "KeyQ".to_owned(),
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
        });
        first.settings = MacroRuntimeSettings {
            startup_delay_ms: 0,
            key_hold_ms: 100,
            post_input_delay_ms: 0,
            default_loop_delay_ms: 0,
        };
        let _ = start_and_ack_focus(&runtime, &receiver, first);
        let startup = next_wait(&waits);
        startup.release.send(()).unwrap();
        let first_hold = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(first_hold))
            .unwrap();
        let key_hold = next_wait(&waits);
        assert_eq!(key_hold.duration_ms, 100);

        let mut second = request(vec![MacroStepDefinition::Key {
            id: "second-key".to_owned(),
            code: "F3".to_owned(),
            modifiers: None,
            action: Some("tap".to_owned()),
            label: None,
            duration_ms: None,
        }]);
        second.macro_id = "m2".to_owned();
        second.macros[0].id = "m2".to_owned();
        let second_runtime = runtime.clone();
        let second_start = thread::spawn(move || second_runtime.start(second).unwrap());
        let second_focus = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(second_focus))
            .unwrap();
        second_start.join().unwrap();
        let second_startup = next_wait(&waits);
        assert_eq!(second_startup.duration_ms, 0);
        second_startup.release.send(()).unwrap();
        {
            assert_no_browser_actions(&receiver, Duration::from_millis(25));
        };

        key_hold.release.send(()).unwrap();
        let first_release = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(first_release))
            .unwrap();
        let first_post = next_wait(&waits);
        first_post.release.send(()).unwrap();
        let second_hold = next_browser_actions(&receiver);
        assert!(matches!(
            second_hold[0].action,
            BrowserAction::Key {
                ref code,
                ref phase,
                ..
            } if code.as_deref() == Some("F3") && phase == "hold"
        ));
        runtime
            .dispatch_results(success_results(second_hold))
            .unwrap();
        let second_key_hold = next_wait(&waits);
        assert_eq!(second_key_hold.duration_ms, 1);
        second_key_hold.release.send(()).unwrap();
        let second_release = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(second_release))
            .unwrap();
        let second_post_input = next_wait(&waits);
        assert_eq!(second_post_input.duration_ms, 0);
        second_post_input.release.send(()).unwrap();
    }

    #[test]
    fn keeps_held_key_cleanup_inside_the_same_role_input_sequence() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let (runtime, waits) = runtime_with_manual_wait(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let _ = start_and_ack_focus(
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
        let held_startup = next_wait(&waits);
        assert_eq!(held_startup.duration_ms, 0);
        held_startup.release.send(()).unwrap();
        let held = next_browser_actions(&receiver);
        runtime.dispatch_results(success_results(held)).unwrap();
        let held_post_input = next_wait(&waits);
        assert_eq!(held_post_input.duration_ms, 0);
        held_post_input.release.send(()).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while runtime.statuses().unwrap()[0].iteration.unwrap_or_default() == 0 {
            assert!(std::time::Instant::now() < deadline);
            thread::yield_now();
        }

        let mut second = request(vec![MacroStepDefinition::Key {
            id: "queued-key".to_owned(),
            code: "F2".to_owned(),
            modifiers: None,
            action: Some("tap".to_owned()),
            label: None,
            duration_ms: None,
        }]);
        second.macro_id = "m2".to_owned();
        second.macros[0].id = "m2".to_owned();
        second.macros[0].trigger = Some(crate::model::MacroTrigger::Keyboard {
            code: "KeyQ".to_owned(),
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
        });
        second.settings = MacroRuntimeSettings {
            startup_delay_ms: 0,
            key_hold_ms: 100,
            post_input_delay_ms: 0,
            default_loop_delay_ms: 0,
        };
        let _ = start_and_ack_focus(&runtime, &receiver, second);
        let startup = next_wait(&waits);
        startup.release.send(()).unwrap();
        let queued_hold = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(queued_hold))
            .unwrap();
        let key_hold = next_wait(&waits);

        let stopping_runtime = runtime.clone();
        let stop = thread::spawn(move || stopping_runtime.stop_macro("m1").unwrap());
        {
            assert_no_browser_actions(&receiver, Duration::from_millis(25));
            assert!(!stop.is_finished());
        };
        {
            assert_no_browser_actions(&receiver, Duration::from_millis(25));
            assert!(!stop.is_finished());
        };
        {
            assert_no_browser_actions(&receiver, Duration::from_millis(25));
            assert!(!stop.is_finished());
        };
        key_hold.release.send(()).unwrap();
        let queued_release = next_browser_actions(&receiver);
        assert!(matches!(
            queued_release[0].action,
            BrowserAction::Key {
                ref code,
                ref phase,
                ..
            } if code.as_deref() == Some("F2") && phase == "release"
        ));
        runtime
            .dispatch_results(success_results(queued_release))
            .unwrap();
        let post_input = next_wait(&waits);
        post_input.release.send(()).unwrap();
        let held_release = next_browser_actions(&receiver);
        assert!(matches!(
            held_release[0].action,
            BrowserAction::Key {
                ref code,
                ref phase,
                ..
            } if code.as_deref() == Some("KeyW") && phase == "release"
        ));
        runtime
            .dispatch_results(success_results(held_release))
            .unwrap();
        stop.join().unwrap();
    }

    #[test]
    fn stopping_from_one_assigned_role_cancels_the_sibling_invocation() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut request = request(vec![MacroStepDefinition::Key {
            id: "held".to_owned(),
            code: "KeyW".to_owned(),
            modifiers: None,
            action: Some("hold_until_stop".to_owned()),
            label: None,
            duration_ms: None,
        }]);
        request.macros[0].role_ids.push("r2".to_owned());
        request.active_role_ids.push("r2".to_owned());
        let (_, focus) = start_and_ack_focus(&runtime, &receiver, request);
        let mut action_batches = vec![focus];
        let holds = next_browser_action_count(&receiver, 2);
        action_batches.push(holds.clone());
        runtime.dispatch_results(success_results(holds)).unwrap();

        let stopping_runtime = runtime.clone();
        let stop = thread::spawn(move || {
            stopping_runtime.stop_macro_from_role("m1", "r1").unwrap();
        });
        let mut released_roles = Vec::new();
        while released_roles.len() < 2 {
            let release = next_browser_actions(&receiver);
            released_roles.extend(release.iter().map(|action| action.role_id.clone()));
            runtime.dispatch_results(success_results(release)).unwrap();
        }
        stop.join().unwrap();
        released_roles.sort();
        assert_eq!(released_roles, ["r1", "r2"]);
        assert!(runtime.statuses().unwrap().is_empty());
    }

    #[test]
    fn closing_any_execution_role_stops_the_whole_sibling_invocation() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut request = request(vec![MacroStepDefinition::Key {
            id: "held".to_owned(),
            code: "KeyW".to_owned(),
            modifiers: None,
            action: Some("hold_until_stop".to_owned()),
            label: None,
            duration_ms: None,
        }]);
        request.macros[0].role_ids.push("r2".to_owned());
        request.active_role_ids.push("r2".to_owned());
        let _ = start_and_ack_focus(&runtime, &receiver, request);
        let holds = next_browser_action_count(&receiver, 2);
        runtime.dispatch_results(success_results(holds)).unwrap();

        let stopping_runtime = runtime.clone();
        let stop = thread::spawn(move || stopping_runtime.stop_role("r2").unwrap());
        let releases = next_browser_action_count(&receiver, 2);
        let mut released_roles = releases
            .iter()
            .map(|action| action.role_id.as_str())
            .collect::<Vec<_>>();
        released_roles.sort_unstable();
        {
            assert_eq!(released_roles, ["r1", "r2"]);
        };
        runtime.dispatch_results(success_results(releases)).unwrap();
        stop.join().unwrap();
        assert!(runtime.statuses().unwrap().is_empty());
    }

    #[test]
    fn source_role_starts_all_available_assigned_roles() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut request = request(vec![MacroStepDefinition::Delay {
            id: "wait".to_owned(),
            ms: 60_000,
        }]);
        request.macros[0]
            .role_ids
            .extend(["r2".to_owned(), "r3".to_owned()]);
        request.active_role_ids.push("r2".to_owned());
        request.source_role_id = Some("r2".to_owned());
        let starting_runtime = runtime.clone();
        let start = thread::spawn(move || starting_runtime.start(request).unwrap());
        let focus = next_browser_actions(&receiver);
        assert!(runtime.statuses().unwrap().is_empty());
        runtime
            .dispatch_results(success_results(focus.clone()))
            .unwrap();
        let statuses = start.join().unwrap();
        {
            assert_eq!(
                statuses
                    .iter()
                    .map(|status| status.role_id.as_str())
                    .collect::<Vec<_>>(),
                ["r1", "r2"]
            );
            assert!(statuses.iter().all(|status| status.role_id != "r3"));
        };
        {
            assert_eq!(focus.len(), 2);
            assert_eq!(
                focus
                    .iter()
                    .map(|action| action.role_id.as_str())
                    .collect::<Vec<_>>(),
                ["r1", "r2"]
            );
        };
        {
            runtime.stop_macro("m1").unwrap();
            assert!(runtime.statuses().unwrap().is_empty());
        };
    }

    #[test]
    fn cancellation_releases_owned_held_keys_before_finishing() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![MacroStepDefinition::Key {
            id: "held".to_owned(),
            code: "KeyW".to_owned(),
            modifiers: None,
            action: Some("hold_until_stop".to_owned()),
            label: None,
            duration_ms: None,
        }]);
        start.macros[0].repeat = MacroRepeat::Loop { interval_ms: 1 };
        let (_, focus) = start_and_ack_focus(&runtime, &receiver, start);
        let mut phases = focus.iter().map(|_| "focus".to_owned()).collect::<Vec<_>>();
        while phases.len() < 2 {
            for event in receiver.recv_timeout(Duration::from_secs(2)).unwrap() {
                if let CoreEvent::BrowserActions { actions } = event {
                    for action in &actions {
                        phases.push(match &action.action {
                            BrowserAction::Focus => "focus".to_owned(),
                            BrowserAction::Key { phase, .. } => phase.clone(),
                            _ => "other".to_owned(),
                        });
                    }
                    runtime.dispatch_results(success_results(actions)).unwrap();
                }
            }
        }
        {
            assert_eq!(runtime.statuses().unwrap().len(), 1);
            assert_eq!(phases, ["focus", "hold"]);
        };
        {
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            loop {
                let statuses = runtime.statuses().unwrap();
                // A looped hold remains owned after its first iteration. Advancing
                // further must not dispatch another hold for the same owner.
                if statuses[0].iteration.unwrap_or_default() >= 3 {
                    assert_eq!(statuses[0].state, "running");
                    break;
                }
                assert!(std::time::Instant::now() < deadline);
                thread::yield_now();
            }
        };
        {
            let error = runtime
                .acquire_mutation(vec!["m2".to_owned(), "m1".to_owned()], false)
                .unwrap_err();
            assert_eq!(error.code(), "MACRO_MUTATION_BUSY");
        };
        let stopping_runtime = runtime.clone();
        let stop = thread::spawn(move || stopping_runtime.stop_macro("m1").unwrap());
        while phases.last().map(String::as_str) != Some("release") {
            for event in receiver.recv_timeout(Duration::from_secs(2)).unwrap() {
                if let CoreEvent::BrowserActions { actions } = event {
                    for action in &actions {
                        if let BrowserAction::Key { phase, .. } = &action.action {
                            phases.push(phase.clone());
                        }
                    }
                    runtime.dispatch_results(success_results(actions)).unwrap();
                }
            }
        }
        stop.join().unwrap();
        assert_eq!(phases, ["focus", "hold", "release"]);
        assert!(runtime.statuses().unwrap().is_empty());
        {
            assert_eq!(phases.last().map(String::as_str), Some("release"));
            assert!(runtime.statuses().unwrap().is_empty());
        };
    }

    #[test]
    fn cancellation_releases_a_hold_that_is_acknowledged_after_stop_begins() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let _ = start_and_ack_focus(
            &runtime,
            &receiver,
            request(vec![MacroStepDefinition::Key {
                id: "late-hold".to_owned(),
                code: "KeyW".to_owned(),
                modifiers: None,
                action: Some("hold_until_stop".to_owned()),
                label: None,
                duration_ms: None,
            }]),
        );
        let hold = next_browser_actions(&receiver);
        let owner_id = match &hold[0].action {
            BrowserAction::Key {
                phase, owner_id, ..
            } if phase == "hold" => owner_id.clone(),
            action => panic!("expected pending hold, got {action:?}"),
        };
        let stopping_runtime = runtime.clone();
        let stop = thread::spawn(move || stopping_runtime.stop_macro("m1").unwrap());
        assert_no_browser_actions(&receiver, Duration::from_millis(25));
        assert!(!stop.is_finished());

        runtime.dispatch_results(success_results(hold)).unwrap();
        let release = next_browser_actions(&receiver);
        {
            assert!(matches!(
                release[0].action,
                BrowserAction::Key {
                    ref phase,
                    owner_id: ref release_owner,
                    ..
                } if phase == "release" && release_owner == &owner_id
            ));
            assert!(!stop.is_finished());
        };
        runtime.dispatch_results(success_results(release)).unwrap();
        stop.join().unwrap();
        assert!(runtime.statuses().unwrap().is_empty());
    }

    #[test]
    fn held_key_owners_release_in_reverse_step_order() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let _ = start_and_ack_focus(
            &runtime,
            &receiver,
            request(vec![
                MacroStepDefinition::Key {
                    id: "first".to_owned(),
                    code: "KeyA".to_owned(),
                    modifiers: Some(vec!["primary".to_owned()]),
                    action: Some("hold_until_stop".to_owned()),
                    label: None,
                    duration_ms: None,
                },
                MacroStepDefinition::Key {
                    id: "second".to_owned(),
                    code: "KeyB".to_owned(),
                    modifiers: Some(vec!["primary".to_owned()]),
                    action: Some("hold_until_stop".to_owned()),
                    label: None,
                    duration_ms: None,
                },
            ]),
        );
        for expected_code in ["KeyA", "KeyB"] {
            let hold = next_browser_actions(&receiver);
            assert!(matches!(
                hold[0].action,
                BrowserAction::Key {
                    ref code,
                    ref phase,
                    ..
                } if code.as_deref() == Some(expected_code) && phase == "hold"
            ));
            runtime.dispatch_results(success_results(hold)).unwrap();
        }

        let stopping_runtime = runtime.clone();
        let stop = thread::spawn(move || stopping_runtime.stop_macro("m1").unwrap());
        let mut released_codes = Vec::new();
        for expected_code in ["KeyB", "KeyA"] {
            let release = next_browser_actions(&receiver);
            assert!(matches!(
                release[0].action,
                BrowserAction::Key {
                    ref code,
                    ref phase,
                    ..
                } if code.as_deref() == Some(expected_code) && phase == "release"
            ));
            released_codes.push(expected_code);
            runtime.dispatch_results(success_results(release)).unwrap();
        }
        stop.join().unwrap();
        {
            assert_eq!(released_codes, ["KeyB", "KeyA"]);
        };
    }

    #[test]
    fn uses_distinct_owners_for_two_macros_holding_the_same_role_key() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut first = request(vec![MacroStepDefinition::Key {
            id: "m1-hold".to_owned(),
            code: "KeyW".to_owned(),
            modifiers: None,
            action: Some("hold_until_stop".to_owned()),
            label: None,
            duration_ms: None,
        }]);
        let mut second_macro = first.macros[0].clone();
        second_macro.id = "m2".to_owned();
        second_macro.name = "Second".to_owned();
        second_macro.steps = vec![MacroStepDefinition::Key {
            id: "m2-hold".to_owned(),
            code: "KeyW".to_owned(),
            modifiers: None,
            action: Some("hold_until_stop".to_owned()),
            label: None,
            duration_ms: None,
        }];
        first.macros.push(second_macro);
        let second = MacroStartRequest {
            macro_id: "m2".to_owned(),
            ..first.clone()
        };

        let _ = start_and_ack_focus(&runtime, &receiver, first);
        let first_hold = next_browser_actions(&receiver);
        let first_owner = match &first_hold[0].action {
            BrowserAction::Key {
                phase, owner_id, ..
            } if phase == "hold" => owner_id.clone(),
            action => panic!("expected first held key, got {action:?}"),
        };
        runtime
            .dispatch_results(success_results(first_hold))
            .unwrap();

        let _ = start_and_ack_focus(&runtime, &receiver, second);
        let second_hold = next_browser_actions(&receiver);
        let second_owner = match &second_hold[0].action {
            BrowserAction::Key {
                phase, owner_id, ..
            } if phase == "hold" => owner_id.clone(),
            action => panic!("expected second held key, got {action:?}"),
        };
        runtime
            .dispatch_results(success_results(second_hold))
            .unwrap();

        {
            assert_ne!(first_owner, second_owner);
            assert!(first_owner.contains(":r1:m1:m1-hold"));
            assert!(second_owner.contains(":r1:m2:m2-hold"));
        };

        let stopping_first = runtime.clone();
        let first_stop = thread::spawn(move || stopping_first.stop_macro("m1").unwrap());
        let first_release = next_browser_actions(&receiver);
        assert!(matches!(
            first_release[0].action,
            BrowserAction::Key {
                ref owner_id,
                ref phase,
                ..
            } if phase == "release" && owner_id == &first_owner
        ));
        runtime
            .dispatch_results(success_results(first_release))
            .unwrap();
        first_stop.join().unwrap();
        assert_eq!(runtime.statuses().unwrap()[0].macro_id, "m2");

        let stopping_second = runtime.clone();
        let second_stop = thread::spawn(move || stopping_second.stop_macro("m2").unwrap());
        let second_release = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(second_release))
            .unwrap();
        second_stop.join().unwrap();
        assert!(runtime.statuses().unwrap().is_empty());
    }
