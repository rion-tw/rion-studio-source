use std::sync::mpsc;

    use super::*;
    use crate::model::{MacroRepeat, MacroStepDefinition};

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
        let runtime = MacroRuntime::new(Arc::new(|_| {}));
        let control = new_invocation_control(
            "hung-invocation".to_owned(),
            "m1".to_owned(),
            HashSet::from(["r1".to_owned()]),
        );
        runtime
            .shared
            .inner
            .lock()
            .unwrap()
            .invocations
            .insert(control.id.clone(), Arc::clone(&control));

        let started = Instant::now();
        runtime.request_stop_role("r1").unwrap();

        assert!(started.elapsed() < Duration::from_millis(100));
        assert!(control.cancelled.load(Ordering::Acquire));
        assert!(!*control.finished.0.lock().unwrap());
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
    fn suppresses_only_keys_that_can_match_an_enabled_role_shortcut() {
        let definitions = [
            MacroDefinition {
                id: "matching".to_owned(),
                enabled: true,
                activation_mode: Some("toggle".to_owned()),
                name: "Matching".to_owned(),
                role_ids: vec!["r1".to_owned()],
                trigger: Some(crate::model::MacroTrigger {
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
                trigger: Some(crate::model::MacroTrigger {
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
                id: "percent-click".to_owned(),
                anchor: Some("bottom-right".to_owned()),
                position: crate::model::MacroClickDefinition::Percent {
                    unit: Some("percent".to_owned()),
                    x_percent: -10.0,
                    y_percent: -20.0,
                },
            },
            MacroStepDefinition::Click {
                id: "pixel-click".to_owned(),
                anchor: Some("center".to_owned()),
                position: crate::model::MacroClickDefinition::Pixels {
                    unit: "px".to_owned(),
                    x_px: 12.0,
                    y_px: -8.0,
                },
            },
        ]);
        start.macros[0].repeat = MacroRepeat::Loop { interval_ms: 1_000 };
        let _ = start_and_ack_focus(&runtime, &receiver, start);
        let percent = next_browser_actions(&receiver);
        crate::v1_case!("macro-c39036338d41", {
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
        });
        runtime.dispatch_results(success_results(percent)).unwrap();
        let first_click = wait_for_last_click(&runtime, "r1", 1, "percent-click");
        crate::v1_case!("macro-runtime-09beabfa3d19", {
            assert_eq!(
                (first_click.sequence, first_click.step_id.as_str()),
                (1, "percent-click")
            );
        });

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
        crate::v1_case!("macro-baf3548b5c3b", {
            assert_eq!(
                (first_click.sequence, first_click.step_id.as_str()),
                (1, "percent-click")
            );
            assert_eq!(
                (second_click.sequence, second_click.step_id.as_str()),
                (2, "pixel-click")
            );
        });
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
        }]);
        start.macros[0].trigger = Some(crate::model::MacroTrigger {
            code: "KeyQ".to_owned(),
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
        });
        start.macros[0].role_ids.push("r2".to_owned());
        start.macros[0].repeat = MacroRepeat::Loop { interval_ms: 1_000 };
        let (started, focus) = start_and_ack_focus(&runtime, &receiver, start);
        crate::v1_case!("macro-23762f0194b5", {
            assert_eq!(
                started
                    .iter()
                    .map(|status| status.role_id.as_str())
                    .collect::<Vec<_>>(),
                ["r1"]
            );
        });
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
        crate::v1_case!("macro-87360f7f466d", {
            assert_eq!(loop_waits, [1_000, 1_000, 1_000]);
            assert_eq!(
                phases,
                [
                    "focus", "hold", "release", "hold", "release", "hold", "release"
                ]
            );
            assert!(runtime.statuses().unwrap().is_empty());
        });
    }

    #[test]
    fn v1_applies_startup_timing_once_and_captures_settings_per_start() {
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
        }]);
        first.macros[0].trigger = Some(crate::model::MacroTrigger {
            code: "KeyQ".to_owned(),
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
        });
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
        }]);
        second.macros[0].trigger = Some(crate::model::MacroTrigger {
            code: "KeyQ".to_owned(),
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
        });
        second.settings = MacroRuntimeSettings {
            startup_delay_ms: 0,
            key_hold_ms: 80,
            post_input_delay_ms: 30,
            default_loop_delay_ms: 0,
        };
        let second_waits = drive_timed_tap(&runtime, &receiver, &waits, second);

        crate::v1_case!("macro-89c4b8841d73", {
            assert_eq!(first_waits, [100, 30, 30]);
        });
        crate::v1_case!("macro-02f53b92e12c", {
            assert_eq!(second_waits, [0, 80, 30]);
            assert_eq!(first_waits[1], 30);
        });
    }

    #[test]
    fn v1_omits_implicit_timing_but_keeps_explicit_delays_without_a_shortcut() {
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
        }
        let loop_wait = next_wait(&waits);
        crate::v1_case!("macro-3446dd16a6af", {
            assert_eq!(loop_wait.duration_ms, 50);
            assert!(waits.try_recv().is_err());
        });
        crate::v1_case!("macro-3c7a66fa8062", {
            assert_eq!((explicit.duration_ms, loop_wait.duration_ms), (100, 50));
        });
        runtime.stop_macro("m1").unwrap();
    }
