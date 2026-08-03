#[test]
    fn manually_stopped_synchronous_child_cancels_parent_before_next_step() {
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
            steps: vec![MacroStepDefinition::Delay {
                id: "wait".to_owned(),
                ms: 1_000,
            }],
        });
        start.active_role_ids.push("r2".to_owned());
        let _ = start_and_ack_focus(&runtime, &receiver, start);
        let child_focus = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(child_focus))
            .unwrap();
        let wait_started = std::time::Instant::now();
        while !runtime
            .statuses()
            .unwrap()
            .iter()
            .any(|status| status.macro_id == "child")
        {
            assert!(wait_started.elapsed() < Duration::from_secs(2));
            thread::yield_now();
        }
        runtime.stop_macro("child").unwrap();
        let wait_started = std::time::Instant::now();
        let parent = loop {
            if let Some(status) = runtime
                .statuses()
                .unwrap()
                .into_iter()
                .find(|status| status.macro_id == "m1")
                && status.state == "cancelled"
            {
                break status;
            }
            assert!(wait_started.elapsed() < Duration::from_secs(2));
            thread::yield_now();
        };
        {
            assert_eq!(
                parent.error.as_deref(),
                Some("Cancelled because a called macro was stopped.")
            );
            while let Ok(events) = receiver.try_recv() {
                assert!(
                    events
                        .iter()
                        .all(|event| !matches!(event, CoreEvent::BrowserActions { .. })),
                    "parent dispatched its next step"
                );
            }
        };
        runtime.stop_macro("m1").unwrap();
    }

    #[test]
    fn partial_role_failure_preserves_the_failed_role_and_cancels_siblings() {
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
        let _ = start_and_ack_focus(&runtime, &receiver, start);
        let holds = next_browser_action_count(&receiver, 2);
        let failed = holds.iter().find(|action| action.role_id == "r1").unwrap();
        runtime
            .dispatch_results(vec![BrowserActionResult {
                request_id: failed.request_id.clone(),
                ok: false,
                value_json: None,
                error_code: Some("TARGET_DETACHED".to_owned()),
                error_message: Some("target detached".to_owned()),
            }])
            .unwrap();
        runtime
            .dispatch_results(success_results(
                holds
                    .into_iter()
                    .filter(|action| action.role_id == "r2")
                    .collect(),
            ))
            .unwrap();
        let releases = next_browser_action_count(&receiver, 2);
        assert!(releases.iter().all(|action| matches!(
            action.action,
            BrowserAction::Key {
                ref phase,
                ..
            } if phase == "release"
        )));
        runtime.dispatch_results(success_results(releases)).unwrap();
        let wait_started = std::time::Instant::now();
        let statuses = loop {
            let statuses = runtime.statuses().unwrap();
            if statuses
                .iter()
                .all(|status| matches!(status.state.as_str(), "failed" | "cancelled"))
            {
                break statuses;
            }
            assert!(
                wait_started.elapsed() < Duration::from_secs(2),
                "statuses did not settle: {statuses:?}"
            );
            thread::yield_now();
        };
        {
            assert_eq!(
                statuses
                    .iter()
                    .map(|status| (
                        status.role_id.as_str(),
                        status.state.as_str(),
                        status.error.as_deref(),
                    ))
                    .collect::<Vec<_>>(),
                [
                    ("r1", "failed", Some("target detached")),
                    ("r2", "cancelled", Some(SIBLING_FAILURE_MESSAGE)),
                ]
            );
        };
    }

    #[test]
    fn failed_focus_batch_waits_for_every_role_acknowledgement() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(Vec::new());
        start.macros[0].role_ids.push("r2".to_owned());
        start.active_role_ids.push("r2".to_owned());
        let starting_runtime = runtime.clone();
        let starting = thread::spawn(move || starting_runtime.start(start));
        let focus = next_browser_actions(&receiver);
        let failed = focus.iter().find(|action| action.role_id == "r1").unwrap();
        runtime
            .dispatch_results(vec![BrowserActionResult {
                request_id: failed.request_id.clone(),
                ok: false,
                value_json: None,
                error_code: Some("TARGET_DETACHED".to_owned()),
                error_message: Some("target detached".to_owned()),
            }])
            .unwrap();
        thread::sleep(Duration::from_millis(50));
        assert!(!starting.is_finished());
        runtime
            .dispatch_results(success_results(
                focus
                    .into_iter()
                    .filter(|action| action.role_id == "r2")
                    .collect(),
            ))
            .unwrap();
        let error = starting.join().unwrap().unwrap_err();
        assert_eq!(error.code(), "MACRO_INPUT_FAILED");
        assert!(runtime.statuses().unwrap().is_empty());
    }

    #[test]
    fn focus_preflight_finishes_before_running_status_is_published() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let starting_runtime = runtime.clone();
        let start = thread::spawn(move || starting_runtime.start(request(Vec::new())).unwrap());
        let focus = next_browser_actions(&receiver);
        let status_was_hidden_during_preflight = runtime.statuses().unwrap().is_empty();
        let focused_role_ids = focus
            .iter()
            .filter(|request| matches!(request.action, BrowserAction::Focus))
            .map(|request| request.role_id.clone())
            .collect::<Vec<_>>();
        runtime.dispatch_results(success_results(focus)).unwrap();
        let statuses = start.join().unwrap();
        assert_eq!(statuses.len(), 1);
        {
            assert_eq!(focused_role_ids, ["r1".to_owned()]);
            assert!(status_was_hidden_during_preflight);
        };
    }

    #[test]
    fn stop_role_cancels_an_invocation_during_focus_preflight() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start_request = request(vec![MacroStepDefinition::Key {
            id: "key".to_owned(),
            code: "Digit1".to_owned(),
            modifiers: None,
            action: Some("tap".to_owned()),
            label: None,
        }]);
        start_request.source_role_id = Some("r1".to_owned());
        let starting_runtime = runtime.clone();
        let starting = thread::spawn(move || starting_runtime.start(start_request));
        let late_focus = next_browser_actions(&receiver);

        let stopped_at = Instant::now();
        runtime.stop_role("r1").unwrap();
        assert!(stopped_at.elapsed() < Duration::from_secs(1));
        let error = starting.join().unwrap().unwrap_err();
        assert_eq!(error.code(), "MACRO_INPUT_FAILED");
        assert!(runtime.statuses().unwrap().is_empty());

        runtime
            .dispatch_results(success_results(late_focus))
            .unwrap();
        let deadline = Instant::now() + Duration::from_millis(100);
        while Instant::now() < deadline {
            if let Ok(events) = receiver.recv_timeout(Duration::from_millis(5)) {
                assert!(
                    events
                        .iter()
                        .all(|event| !matches!(event, CoreEvent::BrowserActions { .. })),
                    "a late focus acknowledgement started macro input after stop_role"
                );
            }
        }
    }

    #[test]
    fn triggered_child_spawn_failure_releases_the_pending_start_guard() {
        let control = new_invocation_control(
            "parent".to_owned(),
            "macro-parent".to_owned(),
            HashSet::from(["r1".to_owned()]),
        );
        control.children.0.lock().unwrap().pending_starts = 1;

        finish_pending_child_start_after_spawn(&control, &Err::<(), _>("spawn denied"));

        assert_eq!(control.children.0.lock().unwrap().pending_starts, 0);
    }

    #[test]
    fn rechecks_focus_once_for_each_separate_macro_start() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut focus_count = 0;
        for _ in 0..2 {
            let (_, focus) = start_and_ack_focus(
                &runtime,
                &receiver,
                request(vec![MacroStepDefinition::Key {
                    id: "key".to_owned(),
                    code: "KeyA".to_owned(),
                    modifiers: None,
                    action: Some("tap".to_owned()),
                    label: None,
                }]),
            );
            focus_count += focus
                .iter()
                .filter(|action| matches!(action.action, BrowserAction::Focus))
                .count();
            for expected_phase in ["hold", "release"] {
                let action = next_browser_actions(&receiver);
                assert!(matches!(
                    action[0].action,
                    BrowserAction::Key {
                        ref phase,
                        ..
                    } if phase == expected_phase
                ));
                runtime.dispatch_results(success_results(action)).unwrap();
            }
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            while !runtime.statuses().unwrap().is_empty() {
                assert!(std::time::Instant::now() < deadline);
                thread::yield_now();
            }
        }
        {
            assert_eq!(focus_count, 2);
        };
    }

    #[test]
    fn quick_multi_role_release_waits_for_every_first_iteration_action() {
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
        start.macros[0].activation_mode = Some("while_held".to_owned());
        start.macros[0].trigger = Some(crate::model::MacroTrigger {
            code: "KeyQ".to_owned(),
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
        });
        start.macros[0].repeat = MacroRepeat::Loop { interval_ms: 0 };
        start.macros[0].role_ids.push("r2".to_owned());
        start.active_role_ids.push("r2".to_owned());
        start.source_role_id = Some("r1".to_owned());
        let pressing_runtime = runtime.clone();
        let press = thread::spawn(move || {
            pressing_runtime
                .press(MacroPressRequest {
                    start,
                    press_id: "press-1".to_owned(),
                })
                .unwrap()
        });
        let focus = next_browser_actions(&receiver);
        assert_eq!(focus.len(), 2);
        runtime.dispatch_results(success_results(focus)).unwrap();
        {
            assert_eq!(press.join().unwrap().len(), 2);
        };

        let holds = next_browser_action_count(&receiver, 2);
        assert_eq!(holds.len(), 2);
        let releasing_runtime = runtime.clone();
        let release = thread::spawn(move || {
            releasing_runtime
                .release(MacroReleaseRequest {
                    macro_id: "m1".to_owned(),
                    source_role_id: "r1".to_owned(),
                    press_id: "press-1".to_owned(),
                    mode: "complete_first_iteration".to_owned(),
                })
                .unwrap();
        });
        let release_deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            let control = runtime
                .shared
                .inner
                .lock()
                .unwrap()
                .invocations
                .values()
                .next()
                .cloned()
                .unwrap();
            if control.stop_after_first_iteration.load(Ordering::Acquire) {
                break;
            }
            assert!(
                std::time::Instant::now() < release_deadline,
                "release request did not reach the first-iteration barrier"
            );
            thread::yield_now();
        }
        assert!(!release.is_finished());
        let stopping_runtime = runtime.clone();
        let stop = thread::spawn(move || stopping_runtime.stop_macro("m1").unwrap());
        runtime.dispatch_results(success_results(holds)).unwrap();
        let releases = next_browser_action_count(&receiver, 2);
        {
            assert_eq!(releases.len(), 2);
        };
        {
            assert_eq!(
                releases
                    .iter()
                    .filter(|action| matches!(
                        action.action,
                        BrowserAction::Key {
                            ref phase,
                            ..
                        } if phase == "release"
                    ))
                    .count(),
                2
            );
        };
        runtime.dispatch_results(success_results(releases)).unwrap();
        release.join().unwrap();
        stop.join().unwrap();
        {
            assert!(runtime.statuses().unwrap().is_empty());
        };
        {
            assert!(runtime.statuses().unwrap().is_empty());
        };
    }

    #[test]
    fn immediate_release_interrupts_first_or_later_while_held_iterations() {
        for (completed_iterations, press_id, case_id) in [
            (0, "first-iteration", "macro-8b4e22c0e423"),
            (1, "later-iteration", "macro-cefbad4638d2"),
        ] {
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
            start.macros[0].activation_mode = Some("while_held".to_owned());
            start.macros[0].trigger = Some(crate::model::MacroTrigger {
                code: "KeyQ".to_owned(),
                ctrl: false,
                alt: false,
                shift: false,
                meta: false,
            });
            start.macros[0].repeat = MacroRepeat::Loop { interval_ms: 0 };
            start.source_role_id = Some("r1".to_owned());
            let pressing_runtime = runtime.clone();
            let press_id_for_start = press_id.to_owned();
            let press = thread::spawn(move || {
                pressing_runtime
                    .press(MacroPressRequest {
                        start,
                        press_id: press_id_for_start,
                    })
                    .unwrap()
            });
            let focus = next_browser_actions(&receiver);
            runtime.dispatch_results(success_results(focus)).unwrap();
            press.join().unwrap();

            for _ in 0..completed_iterations {
                let hold = next_browser_actions(&receiver);
                runtime.dispatch_results(success_results(hold)).unwrap();
                let release = next_browser_actions(&receiver);
                runtime.dispatch_results(success_results(release)).unwrap();
            }
            let in_flight_hold = next_browser_actions(&receiver);
            let releasing_runtime = runtime.clone();
            let press_id_for_release = press_id.to_owned();
            let release = thread::spawn(move || {
                releasing_runtime
                    .release(MacroReleaseRequest {
                        macro_id: "m1".to_owned(),
                        source_role_id: "r1".to_owned(),
                        press_id: press_id_for_release,
                        mode: "immediate".to_owned(),
                    })
                    .unwrap();
            });
            thread::sleep(Duration::from_millis(25));
            assert!(!release.is_finished());
            runtime
                .dispatch_results(success_results(in_flight_hold))
                .unwrap();
            let compensating_release = next_browser_actions(&receiver);
            runtime
                .dispatch_results(success_results(compensating_release))
                .unwrap();
            release.join().unwrap();
            match case_id {
                "macro-8b4e22c0e423" => {
                    {
                        assert!(runtime.statuses().unwrap().is_empty());
                    };
                }
                "macro-cefbad4638d2" => {
                    {
                        assert!(runtime.statuses().unwrap().is_empty());
                        while let Ok(events) = receiver.try_recv() {
                            assert!(events.iter().all(|event| {
                                !matches!(event, CoreEvent::BrowserActions { .. })
                            }));
                        }
                    };
                }
                _ => unreachable!(),
            }
        }
    }

    #[test]
    fn zero_delay_loop_yields_without_blocking_the_runtime_caller() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![MacroStepDefinition::Delay {
            id: "zero".to_owned(),
            ms: 0,
        }]);
        start.macros[0].repeat = MacroRepeat::Loop { interval_ms: 0 };
        let _ = start_and_ack_focus(&runtime, &receiver, start);
        let caller_progressed = Arc::new(AtomicBool::new(false));
        let caller_progressed_output = Arc::clone(&caller_progressed);
        let caller = thread::spawn(move || {
            thread::yield_now();
            caller_progressed_output.store(true, Ordering::Release);
        });
        caller.join().unwrap();
        {
            assert!(caller_progressed.load(Ordering::Acquire));
            assert!(
                runtime
                    .statuses()
                    .unwrap()
                    .iter()
                    .any(|status| status.state == "running")
            );
        };
        runtime.stop_macro("m1").unwrap();
    }

    #[test]
    fn held_invocation_ignores_mismatched_source_and_press_ids() {
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
        }]);
        start.macros[0].activation_mode = Some("while_held".to_owned());
        start.source_role_id = Some("r1".to_owned());
        let pressing_runtime = runtime.clone();
        let press = thread::spawn(move || {
            pressing_runtime.press(MacroPressRequest {
                start,
                press_id: "press-correct".to_owned(),
            })
        });
        let focus = next_browser_actions(&receiver);
        runtime.dispatch_results(success_results(focus)).unwrap();
        press.join().unwrap().unwrap();
        let hold = next_browser_actions(&receiver);
        runtime.dispatch_results(success_results(hold)).unwrap();

        {
            for (source_role_id, press_id) in [("r1", "press-other"), ("r2", "press-correct")] {
                runtime
                    .release(MacroReleaseRequest {
                        macro_id: "m1".to_owned(),
                        source_role_id: source_role_id.to_owned(),
                        press_id: press_id.to_owned(),
                        mode: "immediate".to_owned(),
                    })
                    .unwrap();
                assert_eq!(runtime.statuses().unwrap().len(), 1);
                let deadline = std::time::Instant::now() + Duration::from_millis(25);
                while std::time::Instant::now() < deadline {
                    if let Ok(events) = receiver.recv_timeout(Duration::from_millis(5)) {
                        assert!(
                            events
                                .iter()
                                .all(|event| !matches!(event, CoreEvent::BrowserActions { .. })),
                            "a mismatched release stopped the held invocation"
                        );
                    }
                }
            }
        };

        let releasing_runtime = runtime.clone();
        let release = thread::spawn(move || {
            releasing_runtime
                .release(MacroReleaseRequest {
                    macro_id: "m1".to_owned(),
                    source_role_id: "r1".to_owned(),
                    press_id: "press-correct".to_owned(),
                    mode: "immediate".to_owned(),
                })
                .unwrap();
        });
        let key_release = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(key_release))
            .unwrap();
        release.join().unwrap();
        assert!(runtime.statuses().unwrap().is_empty());
    }

    #[test]
    fn immediate_release_during_focus_preflight_never_dispatches_the_first_key() {
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
        start.macros[0].activation_mode = Some("while_held".to_owned());
        start.macros[0].repeat = MacroRepeat::Loop { interval_ms: 0 };
        start.source_role_id = Some("r1".to_owned());
        let pressing_runtime = runtime.clone();
        let press = thread::spawn(move || {
            pressing_runtime.press(MacroPressRequest {
                start,
                press_id: "press-before-focus".to_owned(),
            })
        });

        let focus = next_browser_actions(&receiver);
        runtime
            .release(MacroReleaseRequest {
                macro_id: "m1".to_owned(),
                source_role_id: "r1".to_owned(),
                press_id: "press-before-focus".to_owned(),
                mode: "immediate".to_owned(),
            })
            .unwrap();
        runtime.dispatch_results(success_results(focus)).unwrap();

        {
            assert!(press.join().unwrap().unwrap().is_empty());
            let deadline = std::time::Instant::now() + Duration::from_millis(100);
            while std::time::Instant::now() < deadline {
                if let Ok(events) = receiver.recv_timeout(Duration::from_millis(5)) {
                    assert!(
                        events
                            .iter()
                            .all(|event| !matches!(event, CoreEvent::BrowserActions { .. })),
                        "an input action escaped after the immediate release"
                    );
                }
            }
        };
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while !runtime.statuses().unwrap().is_empty() {
            assert!(std::time::Instant::now() < deadline);
            thread::yield_now();
        }
    }
