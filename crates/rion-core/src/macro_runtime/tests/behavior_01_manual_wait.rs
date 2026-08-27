use std::sync::mpsc;

    use super::*;
    use crate::model::{MacroRepeat, MacroShortcutSourceScope, MacroStepDefinition, MacroTrigger};

    struct ManualWait {
        duration_ms: u32,
        release: mpsc::SyncSender<()>,
        role_id: String,
    }

    #[test]
    fn unfinished_invocation_reports_stop_timeout() {
        let control = new_invocation_control(
            "hung-invocation".to_owned(),
            "m1".to_owned(),
            HashSet::from(["r1".to_owned()]),
        );

        let error = wait_finished_with_timeout(&control, Duration::ZERO).unwrap_err();

        assert_eq!(error.code(), "MACRO_STOP_TIMEOUT");
        assert!(error.to_string().contains("hung-invocation"));
    }

    #[test]
    fn role_stop_request_sets_a_cancellation_fence_without_waiting_for_worker_cleanup() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let control = new_invocation_control(
            "test-invocation".to_owned(),
            "m1".to_owned(),
            HashSet::from(["r1".to_owned(), "r2".to_owned()]),
        );
        runtime
            .shared
            .inner
            .lock()
            .unwrap()
            .invocations
            .insert(control.id.clone(), Arc::clone(&control));
        runtime.seed_running_status("m1", "r1").unwrap();
        runtime.seed_running_status("m1", "r2").unwrap();

        let started = Instant::now();
        runtime.request_stop_role("r1").unwrap();

        assert!(started.elapsed() < Duration::from_millis(100));
        assert!(control.cancelled.load(Ordering::Acquire));
        assert!(!*control.finished.0.lock().unwrap());
        assert!(runtime.statuses().unwrap().is_empty());
        let terminal = receiver.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(matches!(
            terminal.as_slice(),
            [CoreEvent::MacroStatuses {
                reliable: true,
                statuses
            }] if statuses.is_empty()
        ));
        let error = runtime.start(request(Vec::new())).unwrap_err();
        assert_eq!(error.code(), "MACRO_ROLE_STOPPING");

        runtime.allow_role_after_launch("r1");
        assert!(
            !runtime
                .shared
                .inner
                .lock()
                .unwrap()
                .stopping_role_ids
                .contains("r1")
        );
    }

    fn runtime_with_manual_wait(events: EventSink) -> (MacroRuntime, mpsc::Receiver<ManualWait>) {
        let (waits, receiver) = mpsc::channel();
        let waiter: Waiter = Arc::new(move |control, role_id, duration_ms| {
            let (release, released) = mpsc::sync_channel(0);
            waits
                .send(ManualWait {
                    duration_ms,
                    release,
                    role_id: role_id.to_owned(),
                })
                .map_err(|_| "manual wait receiver closed".to_owned())?;
            loop {
                match released.recv_timeout(Duration::from_millis(10)) {
                    Ok(()) => return Ok(()),
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if control.cancelled.load(Ordering::Acquire)
                            || is_role_cancelled(control, role_id)
                        {
                            return Err("macro run cancelled".to_owned());
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        return Err("manual wait release closed".to_owned());
                    }
                }
            }
        });
        (MacroRuntime::new_with_waiter(events, waiter), receiver)
    }

    fn next_wait(receiver: &mpsc::Receiver<ManualWait>) -> ManualWait {
        receiver.recv_timeout(Duration::from_secs(2)).unwrap()
    }

    fn request(steps: Vec<MacroStepDefinition>) -> MacroStartRequest {
        MacroStartRequest {
            macros: vec![MacroDefinition {
                id: "m1".to_owned(),
                enabled: true,
                activation_mode: Some("toggle".to_owned()),
                name: "Macro".to_owned(),
                role_ids: vec!["r1".to_owned()],
                shortcut_source_scope: Default::default(),
                trigger: None,
                repeat: MacroRepeat::Once,
                steps,
            }],
            settings: MacroRuntimeSettings {
                startup_delay_ms: 0,
                key_hold_ms: 1,
                post_input_delay_ms: 0,
                default_loop_delay_ms: 0,
            },
            macro_id: "m1".to_owned(),
            source_role_id: None,
            active_role_ids: vec!["r1".to_owned()],
        }
    }

    #[test]
    fn external_shortcut_source_runs_only_active_execution_roles() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut shortcut = request(vec![MacroStepDefinition::Delay {
            id: "wait".to_owned(),
            ms: 60_000,
        }]);
        shortcut.macros[0].role_ids = vec!["a".to_owned(), "b".to_owned(), "c".to_owned()];
        shortcut.macros[0].shortcut_source_scope = MacroShortcutSourceScope::SelectedRoles {
            role_ids: vec!["d".to_owned()],
        };
        shortcut.macros[0].trigger = Some(MacroTrigger::Keyboard {
            code: "F2".to_owned(),
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
        });
        shortcut.source_role_id = Some("d".to_owned());
        shortcut.active_role_ids = vec![
            "a".to_owned(),
            "b".to_owned(),
            "c".to_owned(),
            "d".to_owned(),
        ];

        let starting_runtime = runtime.clone();
        let start_request = shortcut.clone();
        let starting = thread::spawn(move || starting_runtime.toggle(start_request));
        let focus = next_browser_actions(&receiver);
        let mut focused_role_ids = focus
            .iter()
            .map(|action| action.role_id.clone())
            .collect::<Vec<_>>();
        focused_role_ids.sort();
        assert_eq!(focused_role_ids, ["a", "b", "c"]);
        runtime.dispatch_results(success_results(focus)).unwrap();
        let mut started_role_ids = starting
            .join()
            .unwrap()
            .unwrap()
            .into_iter()
            .map(|status| status.role_id)
            .collect::<Vec<_>>();
        started_role_ids.sort();
        assert_eq!(started_role_ids, ["a", "b", "c"]);
        assert!(runtime.toggle(shortcut.clone()).unwrap().is_empty());

        shortcut.source_role_id = Some("a".to_owned());
        assert!(runtime.toggle(shortcut).is_err());
    }

    #[test]
    fn suppresses_only_keys_that_can_match_an_enabled_role_shortcut() {
        let definitions = [
            MacroDefinition {
                id: "matching".to_owned(),
                enabled: true,
                activation_mode: Some("toggle".to_owned()),
                name: "Matching".to_owned(),
                role_ids: vec!["r1".to_owned()],
                shortcut_source_scope: Default::default(),
                trigger: Some(crate::model::MacroTrigger::Keyboard {
                    code: "KeyE".to_owned(),
                    ctrl: false,
                    alt: false,
                    shift: false,
                    meta: false,
                }),
                repeat: MacroRepeat::Once,
                steps: Vec::new(),
            },
            MacroDefinition {
                id: "other-role".to_owned(),
                enabled: true,
                activation_mode: Some("toggle".to_owned()),
                name: "Other".to_owned(),
                role_ids: vec!["r2".to_owned()],
                shortcut_source_scope: Default::default(),
                trigger: Some(crate::model::MacroTrigger::Keyboard {
                    code: "KeyY".to_owned(),
                    ctrl: false,
                    alt: false,
                    shift: false,
                    meta: false,
                }),
                repeat: MacroRepeat::Once,
                steps: Vec::new(),
            },
        ]
        .into_iter()
        .map(|definition| (definition.id.clone(), definition))
        .collect::<HashMap<_, _>>();

        assert!(should_suppress_overlay_shortcut_for_macros(
            &definitions,
            "r1",
            "KeyE",
            &[]
        ));
        assert!(!should_suppress_overlay_shortcut_for_macros(
            &definitions,
            "r1",
            "KeyY",
            &[]
        ));
        assert!(!should_suppress_overlay_shortcut_for_macros(
            &definitions,
            "r1",
            "Digit1",
            &[]
        ));
    }

    fn triggered_delay_request() -> MacroStartRequest {
        let mut start = request(vec![
            MacroStepDefinition::Macro {
                id: "trigger-child".to_owned(),
                macro_id: "child".to_owned(),
                call_mode: Some("trigger".to_owned()),
            },
            MacroStepDefinition::Delay {
                id: "parent-wait".to_owned(),
                ms: 60_000,
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
                id: "child-wait".to_owned(),
                ms: 60_000,
            }],
        });
        start.active_role_ids.push("r2".to_owned());
        start
    }

    #[test]
    fn emits_ordered_actions_and_consumes_results() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let (_, focus) = start_and_ack_focus(
            &runtime,
            &receiver,
            request(vec![MacroStepDefinition::Key {
                id: "s1".to_owned(),
                code: "KeyA".to_owned(),
                modifiers: None,
                action: Some("tap".to_owned()),
                label: None,
                duration_ms: None,
            }]),
        );
        let mut phases = focus
            .iter()
            .map(|_| "focus".to_owned())
            .collect::<Vec<String>>();
        while phases.len() < 3 {
            for event in receiver.recv_timeout(Duration::from_secs(2)).unwrap() {
                if let CoreEvent::BrowserActions { actions } = event {
                    for action in actions {
                        phases.push(match &action.action {
                            BrowserAction::Focus => "focus".to_owned(),
                            BrowserAction::Key { phase, .. } => phase.clone(),
                            _ => "other".to_owned(),
                        });
                        runtime
                            .dispatch_results(vec![BrowserActionResult {
                                request_id: action.request_id,
                                ok: true,
                                value_json: None,
                                error_code: None,
                                error_message: None,
                            }])
                            .unwrap();
                    }
                }
            }
        }
        assert_eq!(phases, ["focus", "hold", "release"]);
    }

    #[test]
    fn forwards_click_anchors_and_increments_each_role_click_sequence() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![
            MacroStepDefinition::Click {
                button: None,
                id: "percent-click".to_owned(),
                anchor: Some("bottom-right".to_owned()),
                position: crate::model::MacroClickDefinition::Percent {
                    unit: Some("percent".to_owned()),
                    x_percent: -10.0,
                    y_percent: -20.0,
                },
            },
            MacroStepDefinition::Click {
                button: None,
                id: "pixel-click".to_owned(),
                anchor: Some("center".to_owned()),
                position: crate::model::MacroClickDefinition::Pixels {
                    unit: "px".to_owned(),
                    x_px: 12.0,
                    y_px: -8.0,
                },
            },
            MacroStepDefinition::Click {
                button: None,
                id: "reference-pixel-click".to_owned(),
                anchor: Some("top-left".to_owned()),
                position: crate::model::MacroClickDefinition::ReferencePixels {
                    unit: "reference-px".to_owned(),
                    x_reference_px: 214.0,
                    y_reference_px: 0.0,
                },
            },
        ]);
        start.macros[0].repeat = MacroRepeat::Loop { interval_ms: 1_000 };
        let _ = start_and_ack_focus(&runtime, &receiver, start);
        let percent = next_browser_actions(&receiver);
        {
            assert!(matches!(
                percent[0].action,
                BrowserAction::Click {
                    ref anchor,
                    ref unit,
                    x,
                    y,
                    ..
                } if anchor.as_deref() == Some("bottom-right")
                    && unit == "percent"
                    && x == -10.0
                    && y == -20.0
            ));
        };
        runtime.dispatch_results(success_results(percent)).unwrap();
        let first_click = wait_for_last_click(&runtime, "r1", 1, "percent-click");
        {
            assert_eq!(
                (first_click.sequence, first_click.step_id.as_str()),
                (1, "percent-click")
            );
        };

        let pixels = next_browser_actions(&receiver);
        assert!(matches!(
            pixels[0].action,
            BrowserAction::Click {
                ref anchor,
                ref unit,
                x,
                y,
                ..
            } if anchor.as_deref() == Some("center")
                && unit == "px"
                && x == 12.0
                && y == -8.0
        ));
        runtime.dispatch_results(success_results(pixels)).unwrap();
        let second_click = wait_for_last_click(&runtime, "r1", 2, "pixel-click");
        let reference_pixels = next_browser_actions(&receiver);
        assert!(matches!(
            reference_pixels[0].action,
            BrowserAction::Click {
                ref anchor,
                ref unit,
                x,
                y,
                ..
            } if anchor.as_deref() == Some("top-left")
                && unit == "reference-px"
                && x == 214.0
                && y == 0.0
        ));
        runtime
            .dispatch_results(success_results(reference_pixels))
            .unwrap();
        let third_click = wait_for_last_click(&runtime, "r1", 3, "reference-pixel-click");
        {
            assert_eq!(
                (first_click.sequence, first_click.step_id.as_str()),
                (1, "percent-click")
            );
            assert_eq!(
                (second_click.sequence, second_click.step_id.as_str()),
                (2, "pixel-click")
            );
            assert_eq!(
                (third_click.sequence, third_click.step_id.as_str()),
                (3, "reference-pixel-click")
            );
        };
        runtime.stop_macro("m1").unwrap();
    }

    #[test]
    fn one_second_digit_one_loop_completes_three_iterations_without_failing() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let (runtime, waits) = runtime_with_manual_wait(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![MacroStepDefinition::Key {
            id: "digit-1".to_owned(),
            code: "Digit1".to_owned(),
            modifiers: None,
            action: Some("tap".to_owned()),
            label: Some("1".to_owned()),
            duration_ms: None,
        }]);
        start.macros[0].trigger = Some(crate::model::MacroTrigger::Keyboard {
            code: "KeyQ".to_owned(),
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
        });
        start.macros[0].role_ids.push("r2".to_owned());
        start.macros[0].repeat = MacroRepeat::Loop { interval_ms: 1_000 };
        let (started, focus) = start_and_ack_focus(&runtime, &receiver, start);
        {
            assert_eq!(
                started
                    .iter()
                    .map(|status| status.role_id.as_str())
                    .collect::<Vec<_>>(),
                ["r1"]
            );
        };
        let mut phases = focus.iter().map(|_| "focus".to_owned()).collect::<Vec<_>>();
        let startup = next_wait(&waits);
        assert_eq!(startup.duration_ms, 0);
        startup.release.send(()).unwrap();

        let mut loop_waits = Vec::new();
        let mut pending_loop_wait = None;
        for _ in 0..3 {
            for expected_phase in ["hold", "release"] {
                let actions = next_browser_actions(&receiver);
                assert!(actions.iter().all(|action| matches!(
                    action.action,
                    BrowserAction::Key {
                        ref code,
                        ref phase,
                        ..
                    } if code.as_deref() == Some("Digit1") && phase == expected_phase
                )));
                phases.push(expected_phase.to_owned());
                runtime.dispatch_results(success_results(actions)).unwrap();
                if expected_phase == "hold" {
                    let key_hold = next_wait(&waits);
                    assert_eq!(key_hold.duration_ms, 1);
                    key_hold.release.send(()).unwrap();
                } else {
                    let post_input = next_wait(&waits);
                    assert_eq!(post_input.duration_ms, 0);
                    post_input.release.send(()).unwrap();
                }
            }
            let loop_wait = next_wait(&waits);
            loop_waits.push(loop_wait.duration_ms);
            if loop_waits.len() < 3 {
                loop_wait.release.send(()).unwrap();
            } else {
                pending_loop_wait = Some(loop_wait);
            }
        }

        runtime.stop_macro("m1").unwrap();
        drop(pending_loop_wait);
        {
            assert_eq!(loop_waits, [1_000, 1_000, 1_000]);
            assert_eq!(
                phases,
                [
                    "focus", "hold", "release", "hold", "release", "hold", "release"
                ]
            );
            assert!(runtime.statuses().unwrap().is_empty());
        };
    }

    #[test]
    fn two_role_loop_without_a_shortcut_holds_each_key_for_the_configured_duration() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let (runtime, waits) = runtime_with_manual_wait(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![MacroStepDefinition::Key {
            id: "left".to_owned(),
            code: "ArrowLeft".to_owned(),
            modifiers: None,
            action: Some("tap".to_owned()),
            label: Some("Left".to_owned()),
            duration_ms: None,
        }]);
        start.macros[0].role_ids.push("r2".to_owned());
        start.macros[0].repeat = MacroRepeat::Loop { interval_ms: 1_000 };
        start.active_role_ids.push("r2".to_owned());
        start.settings = MacroRuntimeSettings {
            startup_delay_ms: 100,
            key_hold_ms: 30,
            post_input_delay_ms: 30,
            default_loop_delay_ms: 1_000,
        };

        let (statuses, focus) = start_and_ack_focus(&runtime, &receiver, start);
        assert_eq!(focus.len(), 2);
        assert_eq!(statuses.len(), 2);

        let startups = vec![next_wait(&waits), next_wait(&waits)];
        assert_waits_for_roles(&startups, 100, &["r1", "r2"]);
        for startup in startups {
            startup.release.send(()).unwrap();
        }

        let holds = next_browser_action_count(&receiver, 2);
        assert_key_actions_for_roles(&holds, "ArrowLeft", "hold", &["r1", "r2"]);
        runtime.dispatch_results(success_results(holds)).unwrap();

        let key_holds = vec![next_wait(&waits), next_wait(&waits)];
        assert_waits_for_roles(&key_holds, 30, &["r1", "r2"]);
        assert_no_browser_actions(&receiver, Duration::from_millis(25));
        for key_hold in key_holds {
            key_hold.release.send(()).unwrap();
        }

        let releases = next_browser_action_count(&receiver, 2);
        assert_key_actions_for_roles(&releases, "ArrowLeft", "release", &["r1", "r2"]);
        runtime.dispatch_results(success_results(releases)).unwrap();

        let post_inputs = vec![next_wait(&waits), next_wait(&waits)];
        assert_waits_for_roles(&post_inputs, 30, &["r1", "r2"]);
        for post_input in post_inputs {
            post_input.release.send(()).unwrap();
        }

        let loop_waits = vec![next_wait(&waits), next_wait(&waits)];
        assert_waits_for_roles(&loop_waits, 1_000, &["r1", "r2"]);
        runtime.stop_macro("m1").unwrap();
        drop(loop_waits);
        assert!(runtime.statuses().unwrap().is_empty());
    }

    fn assert_waits_for_roles(waits: &[ManualWait], duration_ms: u32, expected_roles: &[&str]) {
        assert!(waits.iter().all(|wait| wait.duration_ms == duration_ms));
        let mut roles = waits
            .iter()
            .map(|wait| wait.role_id.as_str())
            .collect::<Vec<_>>();
        roles.sort_unstable();
        assert_eq!(roles, expected_roles);
    }

    fn assert_key_actions_for_roles(
        actions: &[BrowserActionRequest],
        expected_code: &str,
        expected_phase: &str,
        expected_roles: &[&str],
    ) {
        assert!(actions.iter().all(|action| matches!(
            action.action,
            BrowserAction::Key {
                ref code,
                ref phase,
                ..
            } if code.as_deref() == Some(expected_code) && phase == expected_phase
        )));
        let mut roles = actions
            .iter()
            .map(|action| action.role_id.as_str())
            .collect::<Vec<_>>();
        roles.sort_unstable();
        assert_eq!(roles, expected_roles);
    }

    #[test]
    fn applies_timing_without_shortcuts_and_captures_settings_per_start() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let (runtime, waits) = runtime_with_manual_wait(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut first = request(vec![MacroStepDefinition::Key {
            id: "key".to_owned(),
            code: "KeyA".to_owned(),
            modifiers: None,
            action: Some("tap".to_owned()),
            label: None,
            duration_ms: None,
        }]);
        first.settings = MacroRuntimeSettings {
            startup_delay_ms: 100,
            key_hold_ms: 30,
            post_input_delay_ms: 30,
            default_loop_delay_ms: 0,
        };
        let first_waits = drive_timed_tap(&runtime, &receiver, &waits, first);

        let mut second = request(vec![MacroStepDefinition::Key {
            id: "key".to_owned(),
            code: "KeyA".to_owned(),
            modifiers: None,
            action: Some("tap".to_owned()),
            label: None,
            duration_ms: None,
        }]);
        second.settings = MacroRuntimeSettings {
            startup_delay_ms: 0,
            key_hold_ms: 80,
            post_input_delay_ms: 30,
            default_loop_delay_ms: 0,
        };
        let second_waits = drive_timed_tap(&runtime, &receiver, &waits, second);

        {
            assert_eq!(first_waits, [100, 30, 30]);
        };
        {
            assert_eq!(second_waits, [0, 80, 30]);
            assert_eq!(first_waits[1], 30);
        };
    }

    #[test]
    fn combines_reliable_timing_with_explicit_delays_without_a_shortcut() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let (runtime, waits) = runtime_with_manual_wait(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![
            MacroStepDefinition::Key {
                id: "before".to_owned(),
                code: "KeyA".to_owned(),
                modifiers: None,
                action: Some("tap".to_owned()),
                label: None,
                duration_ms: None,
            },
            MacroStepDefinition::Delay {
                id: "delay".to_owned(),
                ms: 100,
            },
            MacroStepDefinition::Key {
                id: "after".to_owned(),
                code: "KeyB".to_owned(),
                modifiers: None,
                action: Some("tap".to_owned()),
                label: None,
                duration_ms: None,
            },
        ]);
        start.macros[0].repeat = MacroRepeat::Loop { interval_ms: 50 };
        start.settings = MacroRuntimeSettings {
            startup_delay_ms: 500,
            key_hold_ms: 400,
            post_input_delay_ms: 300,
            default_loop_delay_ms: 200,
        };
        let _ = start_and_ack_focus(&runtime, &receiver, start);

        let startup = next_wait(&waits);
        assert_eq!((startup.role_id.as_str(), startup.duration_ms), ("r1", 500));
        startup.release.send(()).unwrap();

        for expected in [("KeyA", "hold"), ("KeyA", "release")] {
            let action = next_browser_actions(&receiver);
            assert!(matches!(
                action[0].action,
                BrowserAction::Key {
                    ref code,
                    ref phase,
                    ..
                } if code.as_deref() == Some(expected.0) && phase == expected.1
            ));
            runtime.dispatch_results(success_results(action)).unwrap();
            let implicit = next_wait(&waits);
            assert_eq!(
                implicit.duration_ms,
                if expected.1 == "hold" { 400 } else { 300 }
            );
            implicit.release.send(()).unwrap();
        }
        let explicit = next_wait(&waits);
        assert_eq!(explicit.role_id, "r1");
        assert_eq!(explicit.duration_ms, 100);
        explicit.release.send(()).unwrap();
        for expected in [("KeyB", "hold"), ("KeyB", "release")] {
            let action = next_browser_actions(&receiver);
            assert!(matches!(
                action[0].action,
                BrowserAction::Key {
                    ref code,
                    ref phase,
                    ..
                } if code.as_deref() == Some(expected.0) && phase == expected.1
            ));
            runtime.dispatch_results(success_results(action)).unwrap();
            let implicit = next_wait(&waits);
            assert_eq!(
                implicit.duration_ms,
                if expected.1 == "hold" { 400 } else { 300 }
            );
            implicit.release.send(()).unwrap();
        }
        let loop_wait = next_wait(&waits);
        {
            assert_eq!(loop_wait.duration_ms, 50);
            assert!(waits.try_recv().is_err());
        };
        {
            assert_eq!(
                (startup.duration_ms, explicit.duration_ms, loop_wait.duration_ms),
                (500, 100, 50)
            );
        };
        runtime.stop_macro("m1").unwrap();
    }

    #[test]
    fn timed_hold_waits_for_its_step_duration_then_releases_before_continuing() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let (runtime, waits) = runtime_with_manual_wait(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![
            MacroStepDefinition::Key {
                id: "timed".to_owned(),
                code: "KeyW".to_owned(),
                modifiers: Some(vec!["shift".to_owned()]),
                action: Some("hold_for_duration".to_owned()),
                label: None,
                duration_ms: Some(1_250),
            },
            MacroStepDefinition::Key {
                id: "after".to_owned(),
                code: "KeyA".to_owned(),
                modifiers: None,
                action: Some("tap".to_owned()),
                label: None,
                duration_ms: None,
            },
        ]);
        start.settings.key_hold_ms = 7;
        start.settings.post_input_delay_ms = 30;
        let _ = start_and_ack_focus(&runtime, &receiver, start);

        let startup = next_wait(&waits);
        startup.release.send(()).unwrap();
        let hold = next_browser_actions(&receiver);
        assert!(matches!(
            hold[0].action,
            BrowserAction::Key {
                ref code,
                ref phase,
                ref modifiers,
                ..
            } if code.as_deref() == Some("KeyW") && phase == "hold" && modifiers == &["shift"]
        ));
        runtime.dispatch_results(success_results(hold)).unwrap();

        let timed_wait = next_wait(&waits);
        assert_eq!(timed_wait.duration_ms, 1_250);
        assert_no_browser_actions(&receiver, Duration::from_millis(25));
        timed_wait.release.send(()).unwrap();
        let release = next_browser_actions(&receiver);
        assert!(matches!(
            release[0].action,
            BrowserAction::Key { ref code, ref phase, .. }
                if code.as_deref() == Some("KeyW") && phase == "release"
        ));
        runtime.dispatch_results(success_results(release)).unwrap();

        let post_input = next_wait(&waits);
        assert_eq!(post_input.duration_ms, 30);
        post_input.release.send(()).unwrap();
        let next_hold = next_browser_actions(&receiver);
        assert!(matches!(
            next_hold[0].action,
            BrowserAction::Key { ref code, ref phase, .. }
                if code.as_deref() == Some("KeyA") && phase == "hold"
        ));
        runtime
            .dispatch_results(success_results(next_hold))
            .unwrap();
        let tap_wait = next_wait(&waits);
        assert_eq!(tap_wait.duration_ms, 7);
        tap_wait.release.send(()).unwrap();
        let next_release = next_browser_actions(&receiver);
        runtime
            .dispatch_results(success_results(next_release))
            .unwrap();
        let final_post_input = next_wait(&waits);
        assert_eq!(final_post_input.duration_ms, 30);
        final_post_input.release.send(()).unwrap();

        let deadline = Instant::now() + Duration::from_secs(2);
        while !runtime.statuses().unwrap().is_empty() {
            assert!(Instant::now() < deadline);
            thread::yield_now();
        }
    }

    #[test]
    fn cancelling_a_timed_hold_releases_the_key_before_terminalizing() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let (runtime, waits) = runtime_with_manual_wait(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let _ = start_and_ack_focus(
            &runtime,
            &receiver,
            request(vec![MacroStepDefinition::Key {
                id: "timed".to_owned(),
                code: "KeyW".to_owned(),
                modifiers: None,
                action: Some("hold_for_duration".to_owned()),
                label: None,
                duration_ms: Some(60_000),
            }]),
        );
        next_wait(&waits).release.send(()).unwrap();
        let hold = next_browser_actions(&receiver);
        runtime.dispatch_results(success_results(hold)).unwrap();
        let _timed_wait = next_wait(&waits);

        let stopping_runtime = runtime.clone();
        let stopping = thread::spawn(move || stopping_runtime.stop_macro("m1"));
        let release = next_browser_actions(&receiver);
        assert!(matches!(
            release[0].action,
            BrowserAction::Key { ref code, ref phase, .. }
                if code.as_deref() == Some("KeyW") && phase == "release"
        ));
        runtime.dispatch_results(success_results(release)).unwrap();
        stopping.join().unwrap().unwrap();
        assert!(runtime.statuses().unwrap().is_empty());
    }

    #[test]
    fn timed_hold_uses_the_same_duration_across_all_execution_roles() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let (runtime, waits) = runtime_with_manual_wait(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let mut start = request(vec![MacroStepDefinition::Key {
            id: "timed".to_owned(),
            code: "KeyW".to_owned(),
            modifiers: None,
            action: Some("hold_for_duration".to_owned()),
            label: None,
            duration_ms: Some(1_200),
        }]);
        start.macros[0].role_ids.push("r2".to_owned());
        start.active_role_ids.push("r2".to_owned());
        let (_, focus) = start_and_ack_focus(&runtime, &receiver, start);
        assert_eq!(focus.len(), 2);

        let startups = vec![next_wait(&waits), next_wait(&waits)];
        for startup in startups {
            startup.release.send(()).unwrap();
        }
        let holds = next_browser_action_count(&receiver, 2);
        assert_key_actions_for_roles(&holds, "KeyW", "hold", &["r1", "r2"]);
        runtime.dispatch_results(success_results(holds)).unwrap();

        let timed_waits = vec![next_wait(&waits), next_wait(&waits)];
        assert_waits_for_roles(&timed_waits, 1_200, &["r1", "r2"]);
        for timed_wait in timed_waits {
            timed_wait.release.send(()).unwrap();
        }
        let releases = next_browser_action_count(&receiver, 2);
        assert_key_actions_for_roles(&releases, "KeyW", "release", &["r1", "r2"]);
        runtime.dispatch_results(success_results(releases)).unwrap();
        let post_inputs = vec![next_wait(&waits), next_wait(&waits)];
        for post_input in post_inputs {
            post_input.release.send(()).unwrap();
        }

        let deadline = Instant::now() + Duration::from_secs(2);
        while !runtime.statuses().unwrap().is_empty() {
            assert!(Instant::now() < deadline);
            thread::yield_now();
        }
    }
