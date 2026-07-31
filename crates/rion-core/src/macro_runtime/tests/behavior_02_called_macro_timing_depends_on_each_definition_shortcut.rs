#[test]
    fn called_macro_timing_depends_on_each_definition_shortcut() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let (runtime, waits) = runtime_with_manual_wait(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![
            MacroStepDefinition::Key {
                id: "parent-key".to_owned(),
                code: "KeyA".to_owned(),
                modifiers: None,
                action: Some("tap".to_owned()),
                label: None,
            },
            MacroStepDefinition::Macro {
                id: "call-child".to_owned(),
                macro_id: "child".to_owned(),
                call_mode: Some("wait".to_owned()),
            },
        ]);
        start.macros[0].trigger = Some(crate::model::MacroTrigger {
            code: "KeyQ".to_owned(),
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
        });
        start.settings = MacroRuntimeSettings {
            startup_delay_ms: 100,
            key_hold_ms: 30,
            post_input_delay_ms: 30,
            default_loop_delay_ms: 0,
        };
        start.macros.push(MacroDefinition {
            id: "child".to_owned(),
            enabled: true,
            activation_mode: Some("toggle".to_owned()),
            name: "Child".to_owned(),
            role_ids: vec!["r2".to_owned()],
            trigger: None,
            repeat: MacroRepeat::Once,
            steps: vec![
                MacroStepDefinition::Key {
                    id: "child-key".to_owned(),
                    code: "KeyB".to_owned(),
                    modifiers: None,
                    action: Some("tap".to_owned()),
                    label: None,
                },
                MacroStepDefinition::Macro {
                    id: "call-grandchild".to_owned(),
                    macro_id: "grandchild".to_owned(),
                    call_mode: Some("wait".to_owned()),
                },
            ],
        });
        start.macros.push(MacroDefinition {
            id: "grandchild".to_owned(),
            enabled: true,
            activation_mode: Some("toggle".to_owned()),
            name: "Grandchild".to_owned(),
            role_ids: vec!["r3".to_owned()],
            trigger: Some(crate::model::MacroTrigger {
                code: "KeyG".to_owned(),
                ctrl: false,
                alt: false,
                shift: false,
                meta: false,
            }),
            repeat: MacroRepeat::Once,
            steps: vec![MacroStepDefinition::Key {
                id: "grandchild-key".to_owned(),
                code: "KeyC".to_owned(),
                modifiers: None,
                action: Some("tap".to_owned()),
                label: None,
            }],
        });
        start
            .active_role_ids
            .extend(["r2".to_owned(), "r3".to_owned()]);
        let _ = start_and_ack_focus(&runtime, &receiver, start);

        let mut timed_waits = Vec::new();
        let parent_startup = next_wait(&waits);
        timed_waits.push(parent_startup.duration_ms);
        parent_startup.release.send(()).unwrap();
        for expected_phase in ["hold", "release"] {
            let action = next_browser_actions(&receiver);
            assert!(matches!(
                action[0].action,
                BrowserAction::Key {
                    ref code,
                    ref phase,
                    ..
                } if code.as_deref() == Some("KeyA") && phase == expected_phase
            ));
            runtime.dispatch_results(success_results(action)).unwrap();
            let wait = next_wait(&waits);
            timed_waits.push(wait.duration_ms);
            wait.release.send(()).unwrap();
        }

        let child_focus = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(child_focus))
            .unwrap();
        for expected_phase in ["hold", "release"] {
            let action = next_browser_actions(&receiver);
            assert!(matches!(
                action[0].action,
                BrowserAction::Key {
                    ref code,
                    ref phase,
                    ..
                } if code.as_deref() == Some("KeyB") && phase == expected_phase
            ));
            runtime.dispatch_results(success_results(action)).unwrap();
            assert!(waits.try_recv().is_err(), "untimed child introduced a wait");
        }

        let grandchild_focus = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(grandchild_focus))
            .unwrap();
        let grandchild_startup = next_wait(&waits);
        timed_waits.push(grandchild_startup.duration_ms);
        grandchild_startup.release.send(()).unwrap();
        for expected_phase in ["hold", "release"] {
            let action = next_browser_actions(&receiver);
            assert!(matches!(
                action[0].action,
                BrowserAction::Key {
                    ref code,
                    ref phase,
                    ..
                } if code.as_deref() == Some("KeyC") && phase == expected_phase
            ));
            runtime.dispatch_results(success_results(action)).unwrap();
            let wait = next_wait(&waits);
            timed_waits.push(wait.duration_ms);
            wait.release.send(()).unwrap();
        }
        {
            assert_eq!(timed_waits, [100, 30, 30, 100, 30, 30]);
        };
    }

    #[test]
    fn rejects_dependency_cycles_before_starting() {
        let runtime = MacroRuntime::new(Arc::new(|_| {}));
        let mut request = request(vec![MacroStepDefinition::Macro {
            id: "s1".to_owned(),
            macro_id: "m1".to_owned(),
            call_mode: Some("wait".to_owned()),
        }]);
        request.macros[0].steps = request.macros[0].steps.clone();
        assert!(runtime.start(request).is_err());
    }

    #[test]
    fn rejects_transitively_unassigned_children_before_focus_preflight() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![MacroStepDefinition::Macro {
            id: "call-child".to_owned(),
            macro_id: "child".to_owned(),
            call_mode: Some("wait".to_owned()),
        }]);
        start.macros.push(MacroDefinition {
            id: "child".to_owned(),
            enabled: true,
            activation_mode: Some("toggle".to_owned()),
            name: "Child".to_owned(),
            role_ids: Vec::new(),
            trigger: None,
            repeat: MacroRepeat::Once,
            steps: Vec::new(),
        });
        let error = runtime.start(start).unwrap_err();
        {
            assert!(matches!(
                error,
                CoreError::InvalidInput(message) if message == UNASSIGNED_WORKFLOW_MESSAGE
            ));
            assert!(receiver.try_recv().is_err());
        };
    }

    #[test]
    fn rejects_disabled_unassigned_and_unavailable_starts() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));

        let mut unavailable = request(Vec::new());
        unavailable.active_role_ids.clear();
        {
            let error = runtime.start(unavailable).unwrap_err();
            assert!(matches!(
                error,
                CoreError::InvalidInput(message)
                    if message == UNAVAILABLE_ROLE_MESSAGE
            ));
            assert!(runtime.statuses().unwrap().is_empty());
        };

        let mut unassigned = request(Vec::new());
        unassigned.macros[0].role_ids.clear();
        {
            let error = runtime.start(unassigned).unwrap_err();
            assert!(matches!(
                error,
                CoreError::InvalidInput(message) if message == UNASSIGNED_WORKFLOW_MESSAGE
            ));
            assert!(receiver.try_recv().is_err());
        };

        let mut disabled = request(Vec::new());
        disabled.macros[0].enabled = false;
        {
            let error = runtime.start(disabled).unwrap_err();
            assert!(matches!(
                error,
                CoreError::InvalidInput(message)
                    if message == DISABLED_MACRO_MESSAGE
            ));
            assert!(runtime.statuses().unwrap().is_empty());
            assert!(receiver.try_recv().is_err());
        };
    }

    #[test]
    fn waits_for_all_focus_results_before_running_or_dispatching_input() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![MacroStepDefinition::Key {
            id: "key".to_owned(),
            code: "KeyA".to_owned(),
            modifiers: None,
            action: Some("tap".to_owned()),
            label: None,
        }]);
        start.macros[0].role_ids.push("r2".to_owned());
        start.active_role_ids.push("r2".to_owned());
        let starting_runtime = runtime.clone();
        let starting = thread::spawn(move || starting_runtime.start(start));
        let focus = next_browser_action_count(&receiver, 2);
        let r1 = focus
            .iter()
            .find(|action| action.role_id == "r1")
            .cloned()
            .unwrap();
        runtime.dispatch_results(success_results(vec![r1])).unwrap();

        {
            thread::sleep(Duration::from_millis(25));
            assert!(!starting.is_finished());
            assert!(runtime.statuses().unwrap().is_empty());
            assert!(receiver.try_recv().is_err());
        };

        runtime
            .dispatch_results(success_results(
                focus
                    .into_iter()
                    .filter(|action| action.role_id == "r2")
                    .collect(),
            ))
            .unwrap();
        assert_eq!(starting.join().unwrap().unwrap().len(), 2);
        let holds = next_browser_action_count(&receiver, 2);
        runtime.dispatch_results(success_results(holds)).unwrap();
        let releases = next_browser_action_count(&receiver, 2);
        runtime.dispatch_results(success_results(releases)).unwrap();
    }

    #[test]
    fn rejects_duplicate_runs_and_stops_only_the_requested_macro() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let steps = vec![MacroStepDefinition::Delay {
            id: "wait".to_owned(),
            ms: 60_000,
        }];
        let mut first = request(steps.clone());
        first.macros.push(MacroDefinition {
            id: "m2".to_owned(),
            enabled: true,
            activation_mode: Some("toggle".to_owned()),
            name: "Second".to_owned(),
            role_ids: vec!["r2".to_owned()],
            trigger: None,
            repeat: MacroRepeat::Once,
            steps: steps.clone(),
        });
        first.active_role_ids.push("r2".to_owned());
        let (_, _) = start_and_ack_focus(&runtime, &receiver, first.clone());

        {
            let error = runtime.start(first.clone()).unwrap_err();
            assert!(matches!(
                error,
                CoreError::InvalidInput(message)
                    if message == "macro is already running for this role"
            ));
        };

        let mut second = first;
        second.macro_id = "m2".to_owned();
        let (_, _) = start_and_ack_focus(&runtime, &receiver, second);
        {
            runtime.stop_macro("m1").unwrap();
            assert_eq!(
                runtime
                    .statuses()
                    .unwrap()
                    .iter()
                    .map(|status| (status.macro_id.as_str(), status.role_id.as_str()))
                    .collect::<Vec<_>>(),
                [("m2", "r2")]
            );
        };
        runtime.stop_macro("m2").unwrap();
        assert!(runtime.statuses().unwrap().is_empty());
    }

    #[test]
    fn rust_mutation_leases_block_starts_until_the_transaction_finishes() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let lease = runtime
            .acquire_mutation(vec!["m1".to_owned()], false)
            .unwrap();

        let error = runtime.start(request(Vec::new())).unwrap_err();
        {
            assert_eq!(error.code(), "MACRO_MUTATION_BUSY");
        };

        runtime.release_mutation(&lease).unwrap();
        let (statuses, _) = start_and_ack_focus(&runtime, &receiver, request(Vec::new()));
        assert_eq!(statuses.len(), 1);
        runtime.stop_macro("m1").unwrap();
    }

    #[test]
    fn batches_cross_role_actions_and_preserves_each_role_order() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut request = request(vec![
            MacroStepDefinition::Key {
                id: "s1".to_owned(),
                code: "KeyA".to_owned(),
                modifiers: Some(vec!["primary".to_owned(), "shift".to_owned()]),
                action: Some("tap".to_owned()),
                label: None,
            },
            MacroStepDefinition::Click {
                id: "s2".to_owned(),
                anchor: Some("center".to_owned()),
                position: crate::model::MacroClickDefinition::Percent {
                    unit: Some("percent".to_owned()),
                    x_percent: 50.0,
                    y_percent: 50.0,
                },
            },
        ]);
        request.macros[0].role_ids.push("r2".to_owned());
        request.active_role_ids.push("r2".to_owned());
        let (_, focus) = start_and_ack_focus(&runtime, &receiver, request);
        let mut actions = focus
            .iter()
            .map(|action| (action.role_id.clone(), "focus".to_owned()))
            .collect::<Vec<_>>();
        let mut key_operation_modifiers = Vec::new();
        while actions.len() < 8 {
            for event in receiver.recv_timeout(Duration::from_secs(2)).unwrap() {
                if let CoreEvent::BrowserActions {
                    actions: action_requests,
                } = event
                {
                    actions.extend(action_requests.iter().map(|action| {
                        let phase = match &action.action {
                            BrowserAction::Focus => "focus".to_owned(),
                            BrowserAction::Key {
                                phase, modifiers, ..
                            } => {
                                key_operation_modifiers.push(modifiers.clone());
                                phase.clone()
                            }
                            BrowserAction::Click { .. } => "click".to_owned(),
                        };
                        (action.role_id.clone(), phase)
                    }));
                    runtime
                        .dispatch_results(
                            action_requests
                                .into_iter()
                                .map(|action| BrowserActionResult {
                                    request_id: action.request_id,
                                    ok: true,
                                    value_json: None,
                                    error_code: None,
                                    error_message: None,
                                })
                                .collect(),
                        )
                        .unwrap();
                }
            }
        }
        {
            for role_id in ["r1", "r2"] {
                assert_eq!(
                    actions
                        .iter()
                        .filter(|(role, _)| role == role_id)
                        .map(|(_, phase)| phase.as_str())
                        .collect::<Vec<_>>(),
                    ["focus", "hold", "release", "click"]
                );
            }
        };
        {
            assert_eq!(
                key_operation_modifiers,
                [
                    vec!["primary".to_owned(), "shift".to_owned()],
                    vec!["primary".to_owned(), "shift".to_owned()],
                    vec!["primary".to_owned(), "shift".to_owned()],
                    vec!["primary".to_owned(), "shift".to_owned()],
                ]
            );
        };
    }

    #[test]
    fn ordinary_steps_advance_per_role_before_the_first_iteration_barrier() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![MacroStepDefinition::Key {
            id: "key".to_owned(),
            code: "Digit1".to_owned(),
            modifiers: None,
            action: Some("tap".to_owned()),
            label: None,
        }]);
        start.macros[0].role_ids.push("r2".to_owned());
        start.active_role_ids.push("r2".to_owned());
        let _ = start_and_ack_focus(&runtime, &receiver, start);
        let holds = next_browser_action_count(&receiver, 2);
        runtime
            .dispatch_results(success_results(
                holds
                    .iter()
                    .filter(|action| action.role_id == "r2")
                    .cloned()
                    .collect(),
            ))
            .unwrap();
        let r2_release = next_browser_actions(&receiver);
        assert_eq!(r2_release.len(), 1);
        assert_eq!(r2_release[0].role_id, "r2");
        assert!(matches!(
            r2_release[0].action,
            BrowserAction::Key {
                ref phase,
                ..
            } if phase == "release"
        ));
        runtime
            .dispatch_results(success_results(r2_release))
            .unwrap();

        runtime
            .dispatch_results(success_results(
                holds
                    .into_iter()
                    .filter(|action| action.role_id == "r1")
                    .collect(),
            ))
            .unwrap();
        let r1_release = next_browser_actions(&receiver);
        assert_eq!(r1_release.len(), 1);
        assert_eq!(r1_release[0].role_id, "r1");
        runtime
            .dispatch_results(success_results(r1_release))
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while !runtime.statuses().unwrap().is_empty() {
            assert!(std::time::Instant::now() < deadline);
            thread::yield_now();
        }
    }

    #[test]
    fn stop_waits_for_in_flight_actions_and_their_compensating_releases() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![MacroStepDefinition::Key {
            id: "key".to_owned(),
            code: "Digit1".to_owned(),
            modifiers: None,
            action: Some("tap".to_owned()),
            label: None,
        }]);
        start.macros[0].role_ids.push("r2".to_owned());
        start.active_role_ids.push("r2".to_owned());
        let _ = start_and_ack_focus(&runtime, &receiver, start);
        let holds = next_browser_action_count(&receiver, 2);
        let stopping_runtime = runtime.clone();
        let stop = thread::spawn(move || stopping_runtime.stop_macro("m1").unwrap());
        thread::sleep(Duration::from_millis(50));
        {
            assert!(!stop.is_finished());
        };

        runtime.dispatch_results(success_results(holds)).unwrap();
        let releases = next_browser_action_count(&receiver, 2);
        thread::sleep(Duration::from_millis(50));
        assert!(!stop.is_finished());
        runtime.dispatch_results(success_results(releases)).unwrap();
        stop.join().unwrap();
        assert!(runtime.statuses().unwrap().is_empty());
    }

    #[test]
    fn fails_an_unacknowledged_input_with_the_original_timeout_error() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new_with_waiter_and_timeout(
            Arc::new(move |batch| {
                let _ = events.send(batch);
            }),
            Arc::new(default_wait),
            Duration::from_millis(1),
        );
        let _ = start_and_ack_focus(
            &runtime,
            &receiver,
            request(vec![MacroStepDefinition::Key {
                id: "hung".to_owned(),
                code: "KeyA".to_owned(),
                modifiers: None,
                action: Some("tap".to_owned()),
                label: None,
            }]),
        );
        let hung_hold = next_browser_actions(&receiver);
        assert!(matches!(
            hung_hold[0].action,
            BrowserAction::Key { ref phase, .. } if phase == "hold"
        ));

        let compensating_release = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(compensating_release))
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let failed = loop {
            if let Some(status) = runtime
                .statuses()
                .unwrap()
                .into_iter()
                .find(|status| status.state == "failed")
            {
                break status;
            }
            assert!(std::time::Instant::now() < deadline);
            thread::yield_now();
        };
        {
            assert_eq!(
                failed.error.as_deref(),
                Some("Macro input timed out after 10000 ms.")
            );
            runtime
                .dispatch_results(success_results(hung_hold))
                .unwrap();
        };
    }

    #[test]
    fn keeps_only_one_unacknowledged_action_per_role_across_invocations() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let steps = vec![MacroStepDefinition::Delay {
            id: "wait".to_owned(),
            ms: 0,
        }];
        let first_request = request(steps.clone());
        let first_runtime = runtime.clone();
        let first_start = thread::spawn(move || first_runtime.start(first_request).unwrap());
        let first = next_browser_actions(&receiver);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].role_id, "r1");

        let mut second_request = request(steps);
        second_request.macro_id = "m2".to_owned();
        second_request.macros[0].id = "m2".to_owned();
        let second_runtime = runtime.clone();
        let second_start = thread::spawn(move || second_runtime.start(second_request).unwrap());

        {
            let wait_started = std::time::Instant::now();
            while wait_started.elapsed() < Duration::from_millis(100) {
                let remaining = Duration::from_millis(100).saturating_sub(wait_started.elapsed());
                let Ok(batch) = receiver.recv_timeout(remaining) else {
                    break;
                };
                assert!(
                    batch
                        .iter()
                        .all(|event| !matches!(event, CoreEvent::BrowserActions { .. })),
                    "a second same-role action escaped before the first result was acknowledged"
                );
            }
        };
        runtime.dispatch_results(success_results(first)).unwrap();
        first_start.join().unwrap();
        let second = next_browser_actions(&receiver);
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].role_id, "r1");
        runtime.dispatch_results(success_results(second)).unwrap();
        second_start.join().unwrap();
        runtime.shutdown();
    }
