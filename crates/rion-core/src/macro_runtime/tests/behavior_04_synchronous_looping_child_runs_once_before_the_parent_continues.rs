#[test]
    fn synchronous_looping_child_runs_once_before_the_parent_continues() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![
            MacroStepDefinition::Macro {
                id: "call-child".to_owned(),
                macro_id: "child".to_owned(),
                call_mode: Some("wait".to_owned()),
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
            enabled: true,
            activation_mode: Some("toggle".to_owned()),
            name: "Child".to_owned(),
            role_ids: vec!["r2".to_owned()],
            shortcut_source_scope: Default::default(),
            trigger: None,
            repeat: MacroRepeat::Loop { interval_ms: 0 },
            steps: vec![MacroStepDefinition::Key {
                id: "child-key".to_owned(),
                code: "KeyB".to_owned(),
                modifiers: None,
                action: Some("hold_until_stop".to_owned()),
                label: None,
                duration_ms: None,
            }],
        });
        start.active_role_ids.push("r2".to_owned());
        let _ = start_and_ack_focus(&runtime, &receiver, start);
        let control = runtime
            .shared
            .inner
            .lock()
            .unwrap()
            .invocations
            .values()
            .find(|control| control.macro_ids.lock().is_ok_and(|ids| ids.contains("m1")))
            .cloned()
            .unwrap();

        let mut actions = Vec::new();
        while actions.len() < 5 {
            let batch = next_browser_actions(&receiver);
            actions.extend(batch.iter().map(|request| {
                (
                    request.role_id.clone(),
                    match &request.action {
                        BrowserAction::Focus => "focus".to_owned(),
                        BrowserAction::Key { code, phase, .. } => {
                            format!("{}:{phase}", code.as_deref().unwrap_or_default())
                        }
                        _ => "other".to_owned(),
                    },
                )
            }));
            runtime.dispatch_results(success_results(batch)).unwrap();
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while !control.barriers.lock().unwrap().is_empty() {
            assert!(Instant::now() < deadline);
            thread::yield_now();
        }
        assert!(control.barriers.lock().unwrap().is_empty());
        {
            assert_eq!(
                actions,
                [
                    ("r2".to_owned(), "focus".to_owned()),
                    ("r2".to_owned(), "KeyB:hold".to_owned()),
                    ("r2".to_owned(), "KeyB:release".to_owned()),
                    ("r1".to_owned(), "KeyC:hold".to_owned()),
                    ("r1".to_owned(), "KeyC:release".to_owned()),
                ]
            );
        };
        {
            assert_eq!(
                actions
                    .iter()
                    .filter(|(_, phase)| phase.starts_with("KeyB:"))
                    .count(),
                2
            );
        };
        {
            let child_release = actions
                .iter()
                .position(|(_, phase)| phase == "KeyB:release")
                .unwrap();
            let parent_after = actions
                .iter()
                .position(|(_, phase)| phase == "KeyC:hold")
                .unwrap();
            assert!(child_release < parent_after);
        };
    }

    #[test]
    fn atomic_toggle_converges_without_a_phantom_invocation() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let toggle_request = request(vec![MacroStepDefinition::Delay {
            id: "wait".to_owned(),
            ms: 60_000,
        }]);
        let stop_request = toggle_request.clone();
        let starting_runtime = runtime.clone();
        let starting = thread::spawn(move || starting_runtime.toggle(toggle_request));
        let focus = next_browser_actions(&receiver);
        runtime.dispatch_results(success_results(focus)).unwrap();
        assert_eq!(starting.join().unwrap().unwrap().len(), 1);

        assert!(runtime.toggle(stop_request).unwrap().is_empty());
        assert!(runtime.statuses().unwrap().is_empty());
        assert!(runtime.shared.inner.lock().unwrap().invocations.is_empty());
    }

    #[test]
    fn presentation_updates_are_rate_limited_but_terminal_delivery_is_immediate() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        runtime.seed_running_status("m1", "r1").unwrap();

        for _ in 0..1_000 {
            emit_presentation_statuses(&runtime.shared);
        }
        emit_statuses(&runtime.shared, true);

        let batches = receiver.try_iter().collect::<Vec<_>>();
        assert_eq!(batches.len(), 2);
        assert!(batches[0].iter().any(|event| matches!(
            event,
            CoreEvent::MacroStatuses {
                reliable: false,
                ..
            }
        )));
        assert!(
            batches[1]
                .iter()
                .any(|event| matches!(event, CoreEvent::MacroStatuses { reliable: true, .. }))
        );
    }

    #[test]
    fn naturally_finished_once_macro_publishes_its_final_iteration_before_removal() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let start = request(vec![MacroStepDefinition::Click {
            id: "final-click".to_owned(),
            anchor: Some("center".to_owned()),
            position: crate::model::MacroClickDefinition::Percent {
                unit: Some("percent".to_owned()),
                x_percent: 50.0,
                y_percent: 50.0,
            },
        }]);
        let _ = start_and_ack_focus(&runtime, &receiver, start);
        let click = next_browser_actions(&receiver);
        runtime.dispatch_results(success_results(click)).unwrap();

        let mut final_status = None;
        let mut saw_terminal_removal = false;
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline && !saw_terminal_removal {
            let Ok(batch) = receiver.recv_timeout(deadline.saturating_duration_since(Instant::now()))
            else {
                break;
            };
            for event in batch {
                let CoreEvent::MacroStatuses { reliable, statuses } = event else {
                    continue;
                };
                if reliable {
                    saw_terminal_removal |= statuses.is_empty();
                    final_status = final_status.or_else(|| statuses.into_iter().find(|status| {
                        status.macro_id == "m1"
                            && status.iteration == Some(1)
                            && status.last_click.as_ref().is_some_and(|last_click| {
                                last_click.sequence == 1 && last_click.step_id == "final-click"
                            })
                    }));
                }
            }
        }

        assert!(saw_terminal_removal);
        let final_status = final_status.expect(
            "the final reliable status must retain the completed iteration and last input",
        );
        assert_eq!(final_status.state, "running");
        assert!(runtime.statuses().unwrap().is_empty());
    }

    #[test]
    fn role_lock_registries_stay_bounded_across_five_hundred_role_lifecycles() {
        let runtime = MacroRuntime::new(Arc::new(|_| {}));
        for index in 0..500 {
            let role_id = format!("role-{index}");
            drop(input_sequence_role_lock(&runtime.shared, &role_id).unwrap());
            drop(action_role_locks(&runtime.shared, &[role_id]).unwrap());
        }
        drop(input_sequence_role_lock(&runtime.shared, "role-final").unwrap());
        drop(action_role_locks(&runtime.shared, &["role-final".to_owned()]).unwrap());

        assert!(
            runtime
                .shared
                .input_sequence_role_locks
                .lock()
                .unwrap()
                .len()
                <= 1
        );
        assert!(runtime.shared.action_role_locks.lock().unwrap().len() <= 1);
    }

    #[test]
    fn one_thousand_start_stop_cycles_drain_authoritative_runtime_state() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let start = request(vec![MacroStepDefinition::Delay {
            id: "wait".to_owned(),
            ms: 60_000,
        }]);

        for _ in 0..1_000 {
            let _ = start_and_ack_focus(&runtime, &receiver, start.clone());
            runtime.stop_macro("m1").unwrap();
        }

        let inner = runtime.shared.inner.lock().unwrap();
        assert!(inner.invocations.is_empty());
        assert!(inner.statuses.is_empty());
        assert!(inner.held_keys.is_empty());
        assert!(inner.leases.is_empty());
        drop(inner);
        assert!(runtime.shared.pending.lock().unwrap().is_empty());
        assert!(runtime.shared.action_role_locks.lock().unwrap().len() <= 1);
    }

    #[test]
    fn propagates_disabled_and_unavailable_synchronous_child_start_errors() {
        for (child_enabled, child_active, expected_error, case_id) in [
            (false, true, DISABLED_MACRO_MESSAGE, "macro-1b1528b03ec8"),
            (true, false, UNAVAILABLE_ROLE_MESSAGE, "macro-242ee2cae449"),
        ] {
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
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            let failed = loop {
                if let Some(status) = runtime
                    .statuses()
                    .unwrap()
                    .into_iter()
                    .find(|status| status.macro_id == "m1" && status.state == "failed")
                {
                    break status;
                }
                assert!(std::time::Instant::now() < deadline);
                thread::yield_now();
            };
            match case_id {
                "macro-1b1528b03ec8" => {
                    {
                        assert_eq!(failed.error.as_deref(), Some(expected_error));
                    };
                }
                "macro-242ee2cae449" => {
                    {
                        assert_eq!(failed.error.as_deref(), Some(expected_error));
                    };
                }
                _ => unreachable!(),
            }
            runtime.stop_macro("m1").unwrap();
        }
    }

    #[test]
    fn fails_a_parent_when_its_synchronous_child_is_already_active() {
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
                id: "wait".to_owned(),
                ms: 60_000,
            }],
        };
        let definitions = vec![parent, child];
        let base = MacroStartRequest {
            macros: definitions.clone(),
            settings: MacroRuntimeSettings {
                startup_delay_ms: 0,
                key_hold_ms: 0,
                post_input_delay_ms: 0,
                default_loop_delay_ms: 0,
            },
            macro_id: "child".to_owned(),
            source_role_id: None,
            active_role_ids: vec!["r1".to_owned(), "r2".to_owned()],
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
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let parent_status = loop {
            if let Some(status) = runtime
                .statuses()
                .unwrap()
                .into_iter()
                .find(|status| status.macro_id == "parent" && status.state == "failed")
            {
                break status;
            }
            assert!(std::time::Instant::now() < deadline);
            thread::yield_now();
        };
        {
            assert_eq!(
                parent_status.error.as_deref(),
                Some("Called macro \"Child\" is already running.")
            );
            assert!(
                runtime
                    .statuses()
                    .unwrap()
                    .iter()
                    .any(|status| { status.macro_id == "child" && status.state == "running" })
            );
        };
        runtime.stop_macro("child").unwrap();
        runtime.stop_macro("parent").unwrap();
    }

    #[test]
    fn multi_role_sync_barrier_creates_one_child_before_all_parents_continue() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![
            MacroStepDefinition::Macro {
                id: "call-child".to_owned(),
                macro_id: "child".to_owned(),
                call_mode: Some("wait".to_owned()),
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
        start.macros[0].role_ids.push("r2".to_owned());
        start.macros.push(MacroDefinition {
            id: "child".to_owned(),
            enabled: true,
            activation_mode: Some("toggle".to_owned()),
            name: "Child".to_owned(),
            role_ids: vec!["r3".to_owned()],
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
        start
            .active_role_ids
            .extend(["r2".to_owned(), "r3".to_owned()]);
        let _ = start_and_ack_focus(&runtime, &receiver, start);

        let child_focus = next_browser_actions(&receiver);
        {
            assert_eq!(child_focus.len(), 1);
            assert_eq!(child_focus[0].role_id, "r3");
        };
        runtime
            .dispatch_results(success_results(child_focus))
            .unwrap();
        for expected_phase in ["hold", "release"] {
            let child_action = next_browser_actions(&receiver);
            assert_eq!(child_action.len(), 1);
            assert_eq!(child_action[0].role_id, "r3");
            assert!(matches!(
                child_action[0].action,
                BrowserAction::Key {
                    ref phase,
                    ..
                } if phase == expected_phase
            ));
            runtime
                .dispatch_results(success_results(child_action))
                .unwrap();
        }

        let parent_holds = next_browser_action_count(&receiver, 2);
        let mut parent_roles = parent_holds
            .iter()
            .map(|action| action.role_id.as_str())
            .collect::<Vec<_>>();
        parent_roles.sort_unstable();
        {
            assert_eq!(parent_roles, ["r1", "r2"]);
        };
        runtime
            .dispatch_results(success_results(parent_holds))
            .unwrap();
        let parent_releases = next_browser_action_count(&receiver, 2);
        runtime
            .dispatch_results(success_results(parent_releases))
            .unwrap();
    }

    #[test]
    fn supports_nested_synchronous_macro_calls_in_child_first_order() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let macro_c = MacroDefinition {
            id: "c".to_owned(),
            enabled: true,
            activation_mode: Some("toggle".to_owned()),
            name: "C".to_owned(),
            role_ids: vec!["r3".to_owned()],
            shortcut_source_scope: Default::default(),
            trigger: None,
            repeat: MacroRepeat::Once,
            steps: vec![MacroStepDefinition::Key {
                id: "key-c".to_owned(),
                code: "KeyC".to_owned(),
                modifiers: None,
                action: Some("tap".to_owned()),
                label: None,
                duration_ms: None,
            }],
        };
        let macro_b = MacroDefinition {
            id: "b".to_owned(),
            enabled: true,
            activation_mode: Some("toggle".to_owned()),
            name: "B".to_owned(),
            role_ids: vec!["r2".to_owned()],
            shortcut_source_scope: Default::default(),
            trigger: None,
            repeat: MacroRepeat::Once,
            steps: vec![
                MacroStepDefinition::Macro {
                    id: "call-c".to_owned(),
                    macro_id: "c".to_owned(),
                    call_mode: Some("wait".to_owned()),
                },
                MacroStepDefinition::Key {
                    id: "key-b".to_owned(),
                    code: "KeyB".to_owned(),
                    modifiers: None,
                    action: Some("tap".to_owned()),
                    label: None,
                    duration_ms: None,
                },
            ],
        };
        let mut start = request(vec![
            MacroStepDefinition::Macro {
                id: "call-b".to_owned(),
                macro_id: "b".to_owned(),
                call_mode: Some("wait".to_owned()),
            },
            MacroStepDefinition::Key {
                id: "key-a".to_owned(),
                code: "KeyA".to_owned(),
                modifiers: None,
                action: Some("tap".to_owned()),
                label: None,
                duration_ms: None,
            },
        ]);
        start.macros[0].id = "a".to_owned();
        start.macros[0].name = "A".to_owned();
        start.macro_id = "a".to_owned();
        start.macros.extend([macro_b, macro_c]);
        start
            .active_role_ids
            .extend(["r2".to_owned(), "r3".to_owned()]);
        let _ = start_and_ack_focus(&runtime, &receiver, start);

        let mut held_codes = Vec::new();
        while held_codes.len() < 3 {
            let actions = next_browser_actions(&receiver);
            for action in &actions {
                if let BrowserAction::Key { code, phase, .. } = &action.action
                    && phase == "hold"
                {
                    held_codes.push(code.clone().unwrap());
                }
            }
            runtime.dispatch_results(success_results(actions)).unwrap();
        }
        {
            assert_eq!(held_codes, ["KeyC", "KeyB", "KeyA"]);
        };
        let final_release = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(final_release))
            .unwrap();
    }

    #[test]
    fn propagates_a_synchronous_child_action_failure_to_parent_and_child() {
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
            role_ids: vec!["r2".to_owned()],
            shortcut_source_scope: Default::default(),
            trigger: None,
            repeat: MacroRepeat::Once,
            steps: vec![MacroStepDefinition::Key {
                id: "fail".to_owned(),
                code: "KeyF".to_owned(),
                modifiers: None,
                action: Some("tap".to_owned()),
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
            .dispatch_results(vec![BrowserActionResult {
                request_id: child_hold[0].request_id.clone(),
                ok: false,
                value_json: None,
                error_code: Some("TARGET_DETACHED".to_owned()),
                error_message: Some("child target detached".to_owned()),
            }])
            .unwrap();
        let release = next_browser_actions(&receiver);
        runtime.dispatch_results(success_results(release)).unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let statuses = loop {
            let statuses = runtime.statuses().unwrap();
            if statuses.iter().any(|status| {
                status.macro_id == "m1"
                    && status.state == "failed"
                    && status.error.as_deref() == Some("child target detached")
            }) && statuses.iter().any(|status| {
                status.macro_id == "child"
                    && status.state == "failed"
                    && status.error.as_deref() == Some("child target detached")
            }) {
                break statuses;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "child failure statuses did not settle: {statuses:?}"
            );
            thread::yield_now();
        };
        {
            let mut failed = statuses
                .iter()
                .filter(|status| status.state == "failed")
                .map(|status| (status.macro_id.as_str(), status.error.as_deref()))
                .collect::<Vec<_>>();
            failed.sort_unstable();
            assert_eq!(
                failed,
                [
                    ("child", Some("child target detached")),
                    ("m1", Some("child target detached")),
                ]
            );
        };
        runtime.stop_macro("m1").unwrap();
        runtime.stop_macro("child").unwrap();
    }
